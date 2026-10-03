use morrow_search::{content, service, store::Store};
use serde_json::json;

#[test]
fn external_images_require_a_boolean_opt_in() {
    for legacy in [json!({}), json!({"theme":"dark","markReadOnOpen":false})] {
        assert_eq!(
            content::preferences(&legacy, &json!({})).unwrap()["autoLoadExternalImages"],
            false
        );
    }
    for invalid in [
        json!(null),
        json!(0),
        json!(1),
        json!("true"),
        json!([]),
        json!({}),
    ] {
        assert!(
            content::preferences(&json!({}), &json!({"autoLoadExternalImages":invalid})).is_err()
        );
    }
    for enabled in [true, false] {
        assert_eq!(
            content::preferences(&json!({}), &json!({"autoLoadExternalImages":enabled})).unwrap()["autoLoadExternalImages"],
            enabled
        );
    }
}

#[test]
fn reading_consent_survives_partial_saves_restart_and_can_be_revoked() {
    let root = std::env::temp_dir().join(format!("morrow-reading-{}", uuid::Uuid::new_v4()));
    let accounts = json!({"one@fixture.invalid":{"email":"one@fixture.invalid"},
        "two@fixture.invalid":{"email":"two@fixture.invalid"}});
    {
        let db = Store::open(&root).unwrap();
        db.set_settings(&json!({"mailAccounts":accounts,"preferences":{"displayName":"Fictional reader","markReadOnOpen":false}})).unwrap();
        assert_eq!(
            service::state(&db, "all", true, &[0; 32]).unwrap()["settings"]["preferences"]["autoLoadExternalImages"],
            false
        );
        for patch in [
            json!({"autoLoadExternalImages":true}),
            json!({"theme":"dark"}),
        ] {
            let next =
                content::preferences(&db.settings().unwrap()["preferences"], &patch).unwrap();
            db.set_settings(&json!({"preferences":next})).unwrap();
        }
    }
    {
        let db = Store::open(&root).unwrap();
        for owner in ["all", "one@fixture.invalid", "two@fixture.invalid"] {
            let preferences =
                service::state(&db, owner, true, &[0; 32]).unwrap()["settings"]["preferences"]
                    .clone();
            assert_eq!(preferences["autoLoadExternalImages"], true);
            assert_eq!(preferences["displayName"], "Fictional reader");
            assert_eq!(preferences["theme"], "dark");
            assert_eq!(preferences["markReadOnOpen"], false);
        }
        let next = content::preferences(
            &db.settings().unwrap()["preferences"],
            &json!({"autoLoadExternalImages":false}),
        )
        .unwrap();
        db.set_settings(&json!({"preferences":next})).unwrap();
        assert_eq!(db.settings().unwrap()["mailAccounts"], accounts);
    }
    {
        let db = Store::open(&root).unwrap();
        assert_eq!(
            service::state(&db, "all", true, &[0; 32]).unwrap()["settings"]["preferences"]["autoLoadExternalImages"],
            false
        );
    }
    std::fs::remove_dir_all(root).unwrap();
}
