// Pure QA helpers. No DOM access.

// Group QA findings by the part of the project they point at (one panel,
// pages, exports, cache) so thirty findings read as a handful of areas.
export function issueArea(path) {
  const parts = String(path ?? "").split("/").filter(Boolean);
  if (parts[0] === "panels" && parts[1]) return `panels/${parts[1]}`;
  return parts[0] || "project";
}

export function groupIssues(issues) {
  const groups = new Map();
  for (const issue of issues) {
    const area = issueArea(issue?.path);
    if (!groups.has(area)) groups.set(area, []);
    groups.get(area).push(issue);
  }
  return [...groups.entries()];
}
