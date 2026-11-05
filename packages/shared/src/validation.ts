import type { z } from "zod";

type Issue = z.core.$ZodIssue;

const typeNames: Record<string, string> = {
  string: "text",
  number: "a number",
  int: "a whole number",
  boolean: "true or false",
  object: "an object",
  array: "a list",
};

export function fieldLabel(name: string): string {
  if (name === "") return "Request body";
  if (name === name.toUpperCase()) return name;
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function problem(issue: Issue): string {
  switch (issue.code) {
    case "invalid_type":
      return issue.input === undefined
        ? "is required"
        : `must be ${typeNames[issue.expected] ?? `of type ${issue.expected}`}`;
    case "too_small": {
      if (issue.origin === "string") {
        return Number(issue.minimum) <= 1
          ? "is required"
          : `must be at least ${String(issue.minimum)} characters`;
      }
      if (issue.origin === "array" || issue.origin === "set") {
        return `must have at least ${String(issue.minimum)} items`;
      }
      return `must be at least ${String(issue.minimum)}`;
    }
    case "too_big": {
      if (issue.origin === "string")
        return `must be at most ${String(issue.maximum)} characters`;
      if (issue.origin === "array" || issue.origin === "set") {
        return `must have at most ${String(issue.maximum)} items`;
      }
      return `must be at most ${String(issue.maximum)}`;
    }
    case "invalid_format":
      if (issue.format === "email") return "must be a valid email address";
      if (issue.format === "uuid") return "must be a valid id";
      if (issue.format === "datetime" || issue.format === "date")
        return "must be a valid date and time";
      return "has an invalid format";
    case "invalid_value":
      return `must be one of: ${issue.values.map(String).join(", ")}`;
    case "unrecognized_keys":
      return `has unknown fields: ${issue.keys.join(", ")}`;
    default:
      return "is not valid";
  }
}

/** Zod's own wording starts like this; anything else was written by a person in the schema. */
const zodDefaultMessage = /^(Invalid|Too small|Too big|Unrecognized)/;

/**
 * One readable sentence for one validation issue, e.g. `Quantity must be at most 4`.
 * A message a person wrote in the schema (`.min(1, "Enter a title")`) is used as it is.
 */
export function describeIssue(issue: Issue): string {
  if (issue.code === "custom" || !zodDefaultMessage.test(issue.message)) return issue.message;
  const name = issue.path.map(String).join(".");
  return `${fieldLabel(name)} ${problem(issue)}`;
}

/** Groups issues by field name: `{ title: ["Title is required"] }`. */
export function issuesToFieldErrors(
  issues: readonly Issue[],
  rootName = "_",
): Record<string, string[]> {
  return issues.reduce<Record<string, string[]>>((fields, issue) => {
    const key = issue.path.map(String).join(".") || rootName;
    return { ...fields, [key]: [...(fields[key] ?? []), describeIssue(issue)] };
  }, {});
}
