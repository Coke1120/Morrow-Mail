use crate::{
    error::{Error, Result},
    normalize,
};
use aes_gcm::{Aes256Gcm, KeyInit, aead::Aead};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, functions::FunctionFlags, params};
use serde_json::{Value, json};
use std::{
    cell::Cell,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};
use zeroize::Zeroizing;

pub struct Store {
    pub conn: Connection,
    pub directory: PathBuf,
    key: Zeroizing<Vec<u8>>,
    _lock: File,
    epoch: String,
    depth: Cell<usize>,
}
pub fn random_bytes<const N: usize>() -> Result<[u8; N]> {
    let mut bytes = [0; N];
    getrandom::fill(&mut bytes)
        .map_err(|_| Error::new(500, "System randomness is unavailable."))?;
    Ok(bytes)
}
pub fn private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}
pub fn private(path: &Path, directory: bool) -> Result<()> {
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(Error::conflict(
            "Workspace files must not be symbolic links.",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            path,
            fs::Permissions::from_mode(if directory { 0o700 } else { 0o600 }),
        )?;
    }
    #[cfg(windows)]
    {
        private_windows(path, directory)?;
    }
    Ok(())
}
#[cfg(windows)]
fn private_windows(path: &Path, directory: bool) -> Result<()> {
    use std::os::windows::{ffi::OsStrExt, fs::MetadataExt};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, SE_FILE_OBJECT,
                SetNamedSecurityInfoW,
            },
            DACL_SECURITY_INFORMATION, GetSecurityDescriptorDacl,
            PROTECTED_DACL_SECURITY_INFORMATION,
        },
    };
    if fs::symlink_metadata(path)?.file_attributes() & 0x400 != 0 {
        return Err(Error::conflict(
            "Workspace files must not be reparse points.",
        ));
    }
    let name = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let sddl = if directory {
        "D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)"
    } else {
        "D:P(A;;FA;;;OW)(A;;FA;;;SY)"
    }
    .encode_utf16()
    .chain(Some(0))
    .collect::<Vec<_>>();
    let mut descriptor = std::ptr::null_mut();
    // Windows owns the converted descriptor. Keep it live until SetNamedSecurityInfo copies the DACL.
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        ) == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut present = 0;
        let mut defaulted = 0;
        let mut acl = std::ptr::null_mut();
        let result =
            if GetSecurityDescriptorDacl(descriptor, &mut present, &mut acl, &mut defaulted) == 0
                || present == 0
                || acl.is_null()
            {
                Err(std::io::Error::last_os_error())
            } else {
                let status = SetNamedSecurityInfoW(
                    name.as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    acl,
                    std::ptr::null(),
                );
                if status == 0 {
                    Ok(())
                } else {
                    Err(std::io::Error::from_raw_os_error(status as i32))
                }
            };
        LocalFree(descriptor);
        result?;
    }
    Ok(())
}

fn decrypt(key: &[u8], value: &str) -> Result<Value> {
    let invalid = || {
        Error::conflict(
            "Cannot decrypt Genmail settings. Restore the matching encryption.key and database from your backup.",
        )
    };
    let bytes = STANDARD.decode(value).map_err(|_| invalid())?;
    if bytes.len() < 28 {
        return Err(invalid());
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| invalid())?;
    let nonce: [u8; 12] = bytes[..12].try_into().map_err(|_| invalid())?;
    let ciphertext = [&bytes[28..], &bytes[12..28]].concat();
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(&nonce.into(), ciphertext.as_slice())
            .map_err(|_| invalid())?,
    );
    let settings: Value = serde_json::from_slice(&plaintext).map_err(|_| invalid())?;
    if !settings.is_object() {
        return Err(invalid());
    }
    Ok(settings)
}
fn encrypt(key: &[u8], value: &Value) -> Result<String> {
    let nonce = random_bytes::<12>()?;
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| Error::conflict("Invalid encryption key."))?;
    let plaintext = Zeroizing::new(serde_json::to_vec(value)?);
    let bytes = cipher
        .encrypt(&nonce.into(), plaintext.as_slice())
        .map_err(|_| Error::new(500, "Could not encrypt settings."))?;
    let length = bytes.len() - 16;
    Ok(STANDARD.encode([nonce.as_slice(), &bytes[length..], &bytes[..length]].concat()))
}
pub fn catalog() -> &'static Value {
    static DATA: std::sync::LazyLock<Value> = std::sync::LazyLock::new(|| {
        serde_json::from_str(include_str!("../resources/catalog.json"))
            .expect("bundled feature catalog")
    });
    &DATA
}
pub fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
pub fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
pub fn merge(mut base: Value, patch: &Value) -> Value {
    if let (Some(base), Some(patch)) = (base.as_object_mut(), patch.as_object()) {
        for (key, value) in patch {
            base.insert(key.clone(), value.clone());
        }
    }
    base
}

impl Store {
    pub fn open(directory: &Path) -> Result<Self> {
        if !directory.is_absolute() {
            return Err(Error::invalid("Choose an absolute workspace directory."));
        }
        fs::create_dir_all(directory)?;
        private(directory, true)?;
        let lock_path = directory.join("writer.lock");
        if lock_path.exists() {
            private(&lock_path, false)?;
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options.open(lock_path)?;
        lock.try_lock().map_err(|_| {
            Error::conflict("This workspace is already open in another Morrow Mail service.")
        })?;
        let database = directory.join("genmail.sqlite");
        let key_path = directory.join("encryption.key");
        let existed = database.exists();
        if !key_path.exists() {
            if existed {
                return Err(Error::conflict(
                    "Existing Genmail database is missing encryption.key. Restore the original key from your backup.",
                ));
            }
            private_file(&key_path, &random_bytes::<32>()?)?;
        }
        private(&key_path, false)?;
        let key = Zeroizing::new(fs::read(&key_path)?);
        if key.len() != 32 {
            return Err(Error::conflict(
                "Genmail encryption.key must contain the original 32-byte key.",
            ));
        }
        if existed {
            private(&database, false)?;
        }
        let conn = Connection::open(&database)?;
        private(&database, false)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        let table_exists = |table: &str| -> Result<bool> {
            Ok(conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)",
                [table],
                |row| row.get(0),
            )?)
        };
        if table_exists("settings")?
            && let Some(value) = conn
                .query_row("SELECT value FROM settings WHERE id=1", [], |row| {
                    row.get::<_, String>(0)
                })
                .optional()?
        {
            decrypt(&key, &value)?;
        }
        if table_exists("search_meta")? {
            let version: Option<i64> =
                conn.query_row("SELECT max(version) FROM search_meta", [], |row| row.get(0))?;
            if version.is_some_and(|version| version != 1) {
                return Err(Error::conflict(
                    "This search schema needs a newer Morrow Mail. The workspace was not migrated.",
                ));
            }
        }
        let migrated = table_exists("morrow_schema")?;
        if migrated
            && conn.query_row("SELECT version FROM morrow_schema", [], |row| {
                row.get::<_, i64>(0)
            })? != 1
        {
            return Err(Error::conflict(
                "This workspace needs a newer Morrow Mail. No migration was made.",
            ));
        }
        let needs_backup = existed
            && !migrated
            && table_exists("settings")?
            && conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM settings WHERE id=1)",
                [],
                |row| row.get::<_, bool>(0),
            )?;
        register_functions(&conn)?;
        // Rust is the sole DB owner after takeover. SQLite's retained exclusive lock also
        // excludes legacy Node versions which do not understand writer.lock.
        conn.execute_batch("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;")?;
        let store = Self {
            conn,
            key,
            directory: directory.to_owned(),
            _lock: lock,
            epoch: uuid::Uuid::new_v4().to_string(),
            depth: Cell::new(0),
        };
        if needs_backup {
            store.backup(
                &directory
                    .join("migration-backups")
                    .join(uuid::Uuid::new_v4().to_string()),
            )?;
        }
        store.conn.execute_batch("PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE;
            CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS messages(account TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(account,id));
            CREATE INDEX IF NOT EXISTS mail_remote ON messages(account,COALESCE(NULLIF(json_extract(data,'$.remoteId'),''),id));
            CREATE INDEX IF NOT EXISTS mail_metadata ON messages(account,COALESCE(json_extract(data,'$.folder'),''),COALESCE(json_extract(data,'$.date'),'') DESC,id,NOT COALESCE(json_extract(data,'$.read'),0),COALESCE(json_extract(data,'$.starred'),0),COALESCE(json_extract(data,'$.category'),''));
            CREATE INDEX IF NOT EXISTS mail_message_id ON messages(account,json_extract(data,'$.messageId'));")?;
        store.conn.execute_batch("CREATE INDEX IF NOT EXISTS mail_pending ON messages(account) WHERE json_extract(data,'$.pending')=1;")?;
        store.transaction(|store| {
            create_index(&store.conn)?;
            store.conn.execute_batch("CREATE TABLE IF NOT EXISTS morrow_schema(version INTEGER PRIMARY KEY); INSERT OR IGNORE INTO morrow_schema VALUES(1);")?;
            let initialized: bool = store.conn.query_row("SELECT EXISTS(SELECT 1 FROM settings WHERE id=1)", [], |row| row.get(0))?;
            if !initialized {
                store.write_settings(&json!({"mail": null, "ai": null, "activeAccount": "demo"}))?;
                for value in catalog()["demo"].as_array().expect("demo messages") {
                    let mut message = value.clone();
                    let offset = DateTime::parse_from_rfc3339(string(&message, "date")).map_err(|_| Error::invalid("Invalid bundled demo date."))?.timestamp_millis();
                    message["date"] = (Utc::now() + chrono::Duration::milliseconds(offset)).to_rfc3339_opts(SecondsFormat::Millis, true).into();
                    store.upsert("demo", &message)?;
                }
            }
            if store.index_remaining()? == 0 {
                store.conn.execute("INSERT OR IGNORE INTO search_meta VALUES(1)", [])?;
            } else {
                store.conn.execute("DELETE FROM search_meta", [])?;
            }
            Ok(())
        })?;
        Ok(store)
    }
    pub fn settings(&self) -> Result<Value> {
        let value = self
            .conn
            .query_row("SELECT value FROM settings WHERE id=1", [], |row| {
                row.get::<_, String>(0)
            })?;
        decrypt(&self.key, &value)
    }
    fn write_settings(&self, settings: &Value) -> Result<()> {
        self.conn.execute(
            "INSERT INTO settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
            [encrypt(&self.key, settings)?],
        )?;
        Ok(())
    }
    pub fn set_settings(&self, patch: &Value) -> Result<Value> {
        if !patch.is_object() {
            return Err(Error::invalid("Settings must be an object."));
        }
        let value = merge(self.settings()?, patch);
        self.write_settings(&value)?;
        Ok(value)
    }
    pub fn get(&self, account: &str, id: &str) -> Result<Option<Value>> {
        let row = self
            .conn
            .query_row(
                "SELECT data FROM messages WHERE account=? AND id=?",
                params![account, id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        row.map(|row| serde_json::from_str(&row).map_err(Into::into))
            .transpose()
    }
    pub fn list(&self, account: &str) -> Result<Vec<Value>> {
        self.conn.prepare("SELECT data FROM messages WHERE account=? ORDER BY json_extract(data,'$.date') DESC,id")?.query_map([account], |row| row.get::<_, String>(0))?.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }
    pub fn upsert(&self, account: &str, message: &Value) -> Result<Value> {
        let id = message["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| Error::invalid("A message identity is required."))?;
        self.conn.execute("INSERT INTO messages VALUES(?,?,?) ON CONFLICT(account,id) DO UPDATE SET data=excluded.data", params![account, id, serde_json::to_string(message)?])?;
        Ok(message.clone())
    }
    pub fn update(&self, account: &str, id: &str, patch: &Value) -> Result<Option<Value>> {
        self.get(account, id)?
            .map(|value| {
                let mut next = merge(value, patch);
                next["id"] = id.into();
                self.upsert(account, &next)
            })
            .transpose()
    }
    pub fn delete(&self, account: &str, id: &str) -> Result<bool> {
        Ok(self.conn.execute(
            "DELETE FROM messages WHERE account=? AND id=?",
            params![account, id],
        )? > 0)
    }
    pub fn revision(&self) -> Result<String> {
        let changes: i64 = self
            .conn
            .query_row("SELECT total_changes()", [], |row| row.get(0))?;
        let external: i64 = self
            .conn
            .query_row("PRAGMA data_version", [], |row| row.get(0))?;
        Ok(format!("{}:{changes}:{external}", self.epoch))
    }
    pub fn transaction<T>(&self, work: impl FnOnce(&Self) -> Result<T>) -> Result<T> {
        let depth = self.depth.get();
        let savepoint = format!("morrow_{depth}");
        self.conn.execute_batch(&if depth == 0 {
            "BEGIN IMMEDIATE".into()
        } else {
            format!("SAVEPOINT {savepoint}")
        })?;
        self.depth.set(depth + 1);
        struct Rollback<'a> {
            store: &'a Store,
            depth: usize,
            statement: String,
            committed: bool,
        }
        impl Drop for Rollback<'_> {
            fn drop(&mut self) {
                self.store.depth.set(self.depth);
                if !self.committed {
                    let _ = self.store.conn.execute_batch(&self.statement);
                }
            }
        }
        let mut guard = Rollback {
            store: self,
            depth,
            statement: if depth == 0 {
                "ROLLBACK".into()
            } else {
                format!("ROLLBACK TO {savepoint}; RELEASE {savepoint}")
            },
            committed: false,
        };
        let value = work(self)?;
        self.conn.execute_batch(&if depth == 0 {
            "COMMIT".into()
        } else {
            format!("RELEASE SAVEPOINT {savepoint}")
        })?;
        guard.committed = true;
        Ok(value)
    }

    pub fn index_remaining(&self) -> Result<i64> {
        Ok(self.conn.query_row("SELECT count(*) FROM messages m LEFT JOIN search_documents d ON d.account=m.account AND d.id=m.id WHERE d.rowid IS NULL", [], |row| row.get(0))?)
    }
    pub fn backfill_batch(&self) -> Result<i64> {
        self.transaction(|store| {
            store.conn.execute_batch(&format!("WITH missing AS MATERIALIZED (SELECT m.rowid FROM messages m LEFT JOIN search_documents d ON d.account=m.account AND d.id=m.id WHERE d.rowid IS NULL LIMIT 100) INSERT INTO search_documents({}) SELECT {} FROM missing p JOIN messages m ON m.rowid=p.rowid", COLUMNS, index_values("m")))?;
            let remaining = store.index_remaining()?;
            if remaining == 0 { store.conn.execute("INSERT OR IGNORE INTO search_meta VALUES(1)", [])?; }
            Ok(remaining)
        })
    }
    pub fn backup(&self, destination: &Path) -> Result<()> {
        let parent = destination
            .parent()
            .ok_or_else(|| Error::invalid("Choose a backup destination."))?;
        fs::create_dir_all(parent)?;
        fs::create_dir(destination)?;
        private(destination, true)?;
        let work = || -> Result<()> {
            let path = destination.join("genmail.sqlite");
            self.conn
                .execute("VACUUM INTO ?", [path.to_string_lossy().as_ref()])?;
            private(&path, false)?;
            private_file(&destination.join("encryption.key"), &self.key)?;
            for name in ["pending-calendar.json", "client-state.json"] {
                let source = self.directory.join(name);
                if source.exists() {
                    private_file(&destination.join(name), &fs::read(source)?)?;
                }
            }
            let db =
                Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            if db.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))? != "ok" {
                return Err(Error::conflict("Backup integrity verification failed."));
            }
            let encrypted = db.query_row("SELECT value FROM settings WHERE id=1", [], |row| {
                row.get::<_, String>(0)
            })?;
            decrypt(&self.key, &encrypted)?;
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(&path)?
                .sync_all()?;
            #[cfg(unix)]
            {
                File::open(destination)?.sync_all()?;
                File::open(parent)?.sync_all()?;
            }
            Ok(())
        };
        if let Err(error) = work() {
            let _ = fs::remove_dir_all(destination);
            return Err(error);
        }
        Ok(())
    }
}
pub fn register_functions(conn: &Connection) -> Result<()> {
    let flags = FunctionFlags::SQLITE_UTF8
        | FunctionFlags::SQLITE_DETERMINISTIC
        | FunctionFlags::SQLITE_INNOCUOUS;
    conn.create_scalar_function("mail_normalize", 1, flags, |context| {
        Ok(normalize::normalize(
            &context.get::<Option<String>>(0)?.unwrap_or_default(),
        ))
    })?;
    conn.create_scalar_function("mail_tokens", 1, flags, |context| {
        Ok(normalize::tokens(
            &context.get::<Option<String>>(0)?.unwrap_or_default(),
        ))
    })?;
    Ok(())
}
const COLUMNS: &str =
    "rowid,account,id,date,folder,unread,starred,category,sender,recipients,subject,body,labels";
fn index_values(p: &str) -> String {
    format!("{p}.rowid,{p}.account,{p}.id,
    COALESCE(json_extract({p}.data,'$.date'),''),COALESCE(json_extract({p}.data,'$.folder'),''),
    NOT COALESCE(json_extract({p}.data,'$.read'),0),COALESCE(json_extract({p}.data,'$.starred'),0),COALESCE(json_extract({p}.data,'$.category'),''),
    mail_normalize(COALESCE(json_extract({p}.data,'$.fromName'),'')||' '||COALESCE(json_extract({p}.data,'$.fromEmail'),'')),
    mail_normalize(COALESCE(json_extract({p}.data,'$.to'),'')||' '||COALESCE(json_extract({p}.data,'$.cc'),'')||' '||COALESCE(json_extract({p}.data,'$.bcc'),'')),
    mail_normalize(json_extract({p}.data,'$.subject')),mail_normalize(json_extract({p}.data,'$.body')),mail_normalize(json_extract({p}.data,'$.labels'))")
}
fn create_index(conn: &Connection) -> Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS search_meta(version INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS search_documents(rowid INTEGER PRIMARY KEY,account TEXT NOT NULL,id TEXT NOT NULL,date TEXT,folder TEXT,unread INTEGER,starred INTEGER,category TEXT,sender TEXT,recipients TEXT,subject TEXT,body TEXT,labels TEXT,UNIQUE(account,id));
    CREATE INDEX IF NOT EXISTS search_scope ON search_documents(account,folder,date);
    CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(subject,sender,recipients,body,labels);
    CREATE TABLE IF NOT EXISTS search_vectors(account TEXT NOT NULL,id TEXT NOT NULL,part INTEGER NOT NULL,stamp TEXT NOT NULL,hash TEXT NOT NULL,vector TEXT NOT NULL,PRIMARY KEY(account,id,part));
    CREATE INDEX IF NOT EXISTS mail_date ON search_documents(account,date DESC,id);
    CREATE INDEX IF NOT EXISTS mail_folder_date ON search_documents(account,folder,date DESC,id);
    CREATE INDEX IF NOT EXISTS mail_counts ON search_documents(account,folder,unread,starred);
    CREATE TRIGGER IF NOT EXISTS search_doc_insert AFTER INSERT ON search_documents BEGIN
      INSERT INTO search_fts(rowid,subject,sender,recipients,body,labels) VALUES(new.rowid,mail_tokens(new.subject),mail_tokens(new.sender),mail_tokens(new.recipients),mail_tokens(new.body),mail_tokens(new.labels)); END;
    CREATE TRIGGER IF NOT EXISTS search_doc_delete AFTER DELETE ON search_documents BEGIN DELETE FROM search_fts WHERE rowid=old.rowid; END;
    CREATE TRIGGER IF NOT EXISTS search_message_delete AFTER DELETE ON messages BEGIN DELETE FROM search_documents WHERE rowid=old.rowid; DELETE FROM search_vectors WHERE account=old.account AND id=old.id; END;")?;
    conn.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS search_message_insert AFTER INSERT ON messages BEGIN INSERT INTO search_documents({COLUMNS}) VALUES({values}); END;
        CREATE TRIGGER IF NOT EXISTS search_message_update AFTER UPDATE ON messages BEGIN DELETE FROM search_documents WHERE rowid=old.rowid; INSERT INTO search_documents({COLUMNS}) VALUES({values}); END;", values=index_values("new")))?;
    Ok(())
}
