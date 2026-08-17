import {
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js";
import type { IdentifierType } from "@remote-control-hub/contracts";

export const normalizeIdentifier = (
  type: IdentifierType,
  value: string,
  defaultCountry?: CountryCode,
): string => {
  const trimmed = value.trim().normalize("NFC");
  if (type === "email") {
    const normalized = trimmed.toLocaleLowerCase("en-US");
    const separator = normalized.lastIndexOf("@");
    if (
      separator < 1 ||
      separator === normalized.length - 1 ||
      normalized.length > 320
    ) {
      throw new Error("identifier_invalid");
    }
    return normalized;
  }

  const phone = parsePhoneNumberFromString(trimmed, defaultCountry);
  if (phone === undefined || !phone.isValid()) {
    throw new Error("identifier_invalid");
  }
  return phone.number;
};
