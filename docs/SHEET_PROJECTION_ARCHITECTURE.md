# Sheet projection architecture

The local `HumanControlPlaneSync` plus `GoogleSheetsApiAdapter` is the only control-plane writer. Command completion, application lifecycle closure, daily work, and other event sources may invoke this shared path; Apps Script only exposes the Career Ops menu and dispatches signed `jobs.sync` or `communities.sync` commands.

Projection has two separate phases:

- Structural initialization runs only when a managed tab/column is missing or the spreadsheet developer metadata `CAREER_OPS_SHEET_UX_VERSION` differs from the current version. It owns headers, formats, visibility, dimensions, freezes, validations, ordering, and README layout.
- Data projection reads formulas and values, preserves unsynced human-owned cells, computes bounded cell/range differences, and writes only changed ranges. Deleted rows are cleared only across their contracted width. Identical state produces zero Sheets write requests.

The projection does not change timestamps merely because it ran. It does not clear whole tabs, rebuild formatting, hide/show columns, or reapply validations on a no-op. TODAY validations are updated only when TODAY data changes. Rank/membership changes may update a bounded set of rows; summary changes may update only summary cells.

Apps Script has no time-driven redraw responsibility. Its allowed responsibilities are `onOpen`, `onEdit`, menu creation, and signed command dispatch. Legacy 60-second job-sync polling is disabled. Background reconciliation can run every five minutes, but it invokes Sheet projection only after an authoritative lifecycle change; a second identical projection has zero data and structural mutations.

Human safety is unchanged: yellow/human-owned values are merged from the live Sheet before background writes and are not overwritten until a successful pull makes the registry authoritative.
