import fs from "fs/promises";
import { logger } from "./logger";
import { format, toZonedTime } from "date-fns-tz";

const LAST_CREATED = "./last_created.txt";

export async function getLastProcessedDate() {
  try {
    const created = await fs.readFile(LAST_CREATED, "utf-8");
    return created.trim();
  } catch {
    return;
  }
}

export async function setLastProcessedDate(created: string) {
  const date = new Date(created);
  if (isNaN(date.getTime())) {
    logger.error("Invalid date format. Please provide a valid date string.");
    return;
  }

  const formatted = formatDate(created);
  await fs.writeFile(LAST_CREATED, formatted, "utf-8");
}

export function formatDate(dateStr: string | Date): string {
  const timeZone = "Europe/Athens";
  const date = new Date(dateStr);
  const zonedDate = toZonedTime(date, timeZone);
  return format(zonedDate, "yyyy-MM-dd HH:mm:ss", { timeZone });
}
