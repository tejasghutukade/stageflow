# Support runbook — ticket export

Exports of customer names and transcripts are written only to the company file store, under the support desk path.

The export job deletes files 24 months after the related contract ends. A calendar reminder opens a deletion ticket; the ticket is not closed until the file store reports the objects gone.

Product email uses the opt-in flag on the customer record. Rows with the flag unset are left out of the file.

If an export is emailed to the wrong person, the on-call engineer tells security within 4 hours and lists the columns and the ticket ids involved.

Shared links are off. A vendor receives an export only after legal confirms a signed agreement that names this data.

Secrets for the export job live in the secret store under `support/export`. This runbook does not contain them.
