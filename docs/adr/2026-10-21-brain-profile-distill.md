# Email Brain refresh distills the persona

Refresh used to keep a section's old rows whenever the new pass returned that section empty. The living profile grew, and stale auto facts stayed until someone used Forget or Rebuild.

Refresh is a soft distill of the generated persona in `brain.json`. The model returns the full tightened profile, not a list of facts to append. The host prefers those rows. It restores a prior section only when the new pass has no section rows, and only after the same dedupe and cap. Rebuild stays a hard distill from scratch and still keeps user writing rules.

Each generated section is capped at 8 rows. That is the cap `normalizeSections` already used. The host also drops near-duplicate labels and values when the model repeats a fact. Auto writing stays capped at 8 rules and voice quotes at 6. User writing rules are stored apart from the generated JSON.

Neither path edits mailbox messages. Refresh and Rebuild sit on the profile summary card with the owner and fact counts.
