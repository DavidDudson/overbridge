// Decoding of parsed JSON at its I/O boundary. Imports nothing, so the agent hook can use it.
// The guards take `unknown` (the exact subject of a type predicate, which no-unknown-parameters allows) so any caller can narrow.

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

/** Parse JSON text. Throws on malformed input, like `JSON.parse`. */
export const parseJson = (text: string): JsonValue => JSON.parse(text);

export const isJsonObject = (value: unknown): value is JsonObject => Object(value) === value && !Array.isArray(value);

/** A string primitive: only a string equals its own `String()` conversion. */
export const isJsonString = (value: unknown): value is string => value === String(value);

export const isJsonNumber = (value: unknown): value is number => Number.isFinite(value);

export const isJsonBoolean = (value: unknown): value is boolean => value === true || value === false;

/** The field when it is a string, else undefined. */
export function stringField(object: JsonObject, key: string): string | undefined {
  const value = object[key];

  return isJsonString(value) ? value : undefined;
}

/** The field when it is a finite number, else undefined. */
export function numberField(object: JsonObject, key: string): number | undefined {
  const value = object[key];

  return isJsonNumber(value) ? value : undefined;
}

/** The field when it is an object, else undefined. */
export function objectField(object: JsonObject, key: string): JsonObject | undefined {
  const value = object[key];

  return isJsonObject(value) ? value : undefined;
}
