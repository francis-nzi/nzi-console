"use client";

import React from "react";
import { greetingNameFor } from "./staffChrome";
import { useStaffMe } from "./useEditAccess";

/** "Good morning, Sam" - the word for the time of day comes from the server's clock, the name from the signed-in principal; no principal, no name. */
export function StaffGreeting({ word }: { word: string }) {
  const name = greetingNameFor(useStaffMe(true));
  return <>{name ? `${word}, ${name}` : word}</>;
}
