# Checked calendars merge into one month

The calendar sidebar used to select one calendar. The month and agenda now show every calendar that is checked for the selected mailbox. Unchecking hides that calendar's events and does not delete it on Google or Outlook. The last checked calendar cannot be turned off.

`calendar:list` still accepts one `calendarId`. A `calendarIds` array fetches those calendars one after another, each under the existing 500-event cap. A provider error, including a rate limit, stops the rest of that list. Callers that omit `calendarIds` still receive the primary calendar, or the first calendar. Plan My Week is one of those callers.

Create and edit still write to one calendar. A new event starts on the calendar the user last checked on, and the dialog menu can change that destination. After a relaunch, that default is the first saved id for the mailbox. Editing an event stays bound to that event's account and calendar; its calendar menu is disabled because moving is a separate provider operation. A save onto an unchecked calendar checks it so the event is visible. See [confirmed identities](2026-10-24-confirmed-message-and-calendar-identity.md).

The checked ids are stored per mailbox in the renderer profile (`localStorage`, key `morrow.calendarChecks`), the same place as the collapsed sidebar. They are not a Settings field.
