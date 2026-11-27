# Prepare a calendar event from a selected mail passage

This local first pass for #673 reuses the existing Add event editor from the main
Mail Reader's selection menu. It does not call an AI model, read from a provider,
store drafts, send a message or invite guests. A Calendar list already loaded for
the same mailbox is required. The list must have been returned for that specific
connection generation. This action does not silently switch accounts or calendars.

The strict input grammar accepts a date, a start and an end, and an explicit
numeric UTC offset, as one standalone range or two full ISO timestamps. An
explicit title or location can be used without inferring additional details
from the message. Unsupported, incomplete, contradictory or non-appointment
selections leave dates and times blank for manual entry. The existing local
timestamp parser validates the Gregorian date and offset. Candidate times are
only installed if the resulting device-local form values round-trip through
the existing Calendar validator with the exact source instants, so an ambiguous
clock-change input is not silently converted to the wrong instant.

The source excerpt remains visible in the review but never enters the event
description or provider payload. Add event is still the only existing write
boundary; it rechecks the current source view and mailbox connection and the
chosen same-account calendar. Cancel drops the excerpt. Separate Reader windows,
semantic extraction, timezone guessing and provider duration measurements are
out of scope.
