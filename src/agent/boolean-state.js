export function normalizeBooleanState(value) {
  if (typeof value === "boolean") return value;

  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();

  if ([
    "true",
    "enabled",
    "enable",
    "on",
    "yes",
    "checked",
    "selected",
    "1"
  ].includes(normalized)) {
    return true;
  }

  if ([
    "false",
    "disabled",
    "disable",
    "off",
    "no",
    "unchecked",
    "unselected",
    "0"
  ].includes(normalized)) {
    return false;
  }

  return null;
}
