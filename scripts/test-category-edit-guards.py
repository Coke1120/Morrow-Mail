#!/usr/bin/env python3
"""Source contracts for category replacement guards; no native UI execution.

Use --source-ref <commit> for an immutable negative control. The checks inspect
the production handlers, including account navigation and app-wide dirty state.
They supplement, and do not replace, macOS/Windows native acceptance.
"""
import argparse
from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]
PARSER = argparse.ArgumentParser(description=__doc__)
PARSER.add_argument("--source-ref")
ARGS = PARSER.parse_args()


def source(path):
    if ARGS.source_ref:
        return subprocess.check_output(
            ["git", "show", f"{ARGS.source_ref}:{path}"], cwd=ROOT, text=True
        )
    return (ROOT / path).read_text()


MAC = source("macos/Sources/MorrowMail/StudioView.swift")
WIN = source("windows/Intelligence.cpp")


def between(text, start, end):
    """Fail closed if a production handler's inspection boundary changes."""
    assert text.count(start) == 1, f"Handler boundary changed: {start}"
    tail = text.split(start, 1)[1]
    assert end in tail, f"Handler end changed: {end}"
    return tail.split(end, 1)[0]


class CategoryEditGuards(unittest.TestCase):
    def before(self, body, guard, mutation):
        self.assertIn(guard, body)
        self.assertIn(mutation, body)
        self.assertLess(body.index(guard), body.index(mutation))

    def test_mac_account_and_page_navigation_include_category_edits(self):
        self.assertIn("categoryEditor != categoryBaseline || !categoryPrompt.isEmpty", MAC)
        self.assertIn("var studioDirty: Bool { brainDirty || categoryDirty }", MAC)
        account = between(MAC, "ReviewAccountTabs(review: review, canPick:", "HStack {")
        self.assertIn("owner == review.scope || !studioDirty || model.confirmDiscard", account)
        navigate = between(MAC, "func navigate(_ destination: String)", "func ")
        self.before(navigate, "!studioDirty || model.confirmDiscard", "loadCategoryEditor(")
        self.before(navigate, "else { return }", "model.studioTab = destination")

    def test_mac_edit_another_category_and_clear_can_cancel(self):
        categories = between(MAC, "var categoriesPage: some View", "func saveCategory")
        for start, end, replacement in [
            ('Button("Edit") {', 'Button("Delete")', "loadCategoryEditor(category)"),
            ('Button("Clear") {', 'TextField("Draft a category name"', "loadCategoryEditor(Self.blankCategory)"),
        ]:
            with self.subTest(action=start):
                body = between(categories, start, end)
                self.before(body, "guard confirmCategoryDiscard() else { return }", replacement)
        confirm = between(MAC, "func confirmCategoryDiscard()", "func loadCategoryEditor")
        self.assertIn("!categoryDirty || model.confirmDiscard", confirm)

    def test_mac_dirty_changes_reach_navigation_quit_and_update_guards(self):
        for field in ["categoryEditor", "categoryPrompt"]:
            self.assertIn(f'.onChange(of: {field}) {{ _ in model.dirty("category", categoryDirty) }}', MAC)
        load = between(MAC, "func loadCategoryEditor(_ value: JSON)", "func saveCategory")
        self.assertIn('categoryBaseline = value; categoryPrompt = ""', load)
        self.assertIn('model.dirty("category", false)', load)
        model = source("macos/Sources/MorrowMail/AppModel.swift")
        self.assertIn("unsavedForms.isEmpty", between(model, "var canNavigate:", "\n"))
        self.assertIn("!unsavedForms.subtracting", between(model, "var updateHasUnsavedChanges:", "\n"))
        app = source("macos/Sources/MorrowMail/MorrowMailApp.swift")
        self.assertIn('(!model.unsavedForms.isEmpty || model.review.hasEdits) && !model.confirmDiscard', app)

    def test_windows_edit_another_category_and_clear_can_cancel(self):
        for start, end in [
            ('action(p, item, L"Edit", [category]', 'action(p, item, L"Delete…"'),
            ('action(p, fields, L"Clear form",', 'action(p, fields, L"Draft name",'),
        ]:
            with self.subTest(action=start):
                body = between(WIN, start, end)
                self.before(body, 'page->forms[L"category"].dirty() && !(co_await page->shell->confirm', '.accept(')
                self.before(body, ")) co_return;", '.accept(')
                self.before(body, "if (!page->current()) co_return;", '.accept(')
                self.assertIn("page->dirty()", body)

    def test_windows_account_and_page_navigation_consume_editor_dirty_state(self):
        self.assertIn("if (form.dirty()) return true", WIN)
        self.assertIn("if (busy || cancelling || edited()) shell->dirty.insert(key())", WIN)
        account = between(WIN, "tab.Checked([scope, owner]", "tab.Unchecked(")
        self.before(account, "page->edited() && !(co_await", "shell->review->scope = owner")
        self.before(account, ")) co_return;", "page->stop()")
        navigation = between(WIN, "IAsyncAction changePage(", "\n}")
        self.before(navigation, "p->edited() && !(co_await", "p->stop()")
        self.before(navigation, ")) co_return;", "p->stop()")

    def test_replacement_drafts_stay_unsaved_and_reset_discloses_discard(self):
        mac = between(MAC, "func draftCategory()", "func ")
        self.before(mac, "categoryEditor == categoryBaseline || model.confirmDiscard", 'model.request("/workspace/categories/suggest"')
        self.before(mac, "loadCategoryEditor(Self.blankCategory)", "categoryEditor = .object(")
        self.assertIn('model.dirty("category", categoryDirty)', mac)
        win = between(WIN, 'action(p, fields, L"Draft name",', 'action(p, fields, L"Reset suggested categories…",')
        self.before(win, "subset(form.value, fields).Stringify() != subset(form.saved, fields).Stringify() && !(co_await", 'service->request(')
        self.before(win, "form.accept(blankCategory())", "form.value = value")
        self.assertIn('page->changed(L"category")', win)
        for native in [MAC, WIN]:
            self.assertIn("discards unsaved category edits", native)


if __name__ == "__main__":
    unittest.main(argv=[__file__], verbosity=2)
