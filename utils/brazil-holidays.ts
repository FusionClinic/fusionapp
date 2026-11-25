const BRAZIL_TIMEZONE = "America/Fortaleza";

const FIXED_NATIONAL_HOLIDAYS: Record<string, string> = {
  "01-01": "Confraternização Universal",
  "04-21": "Tiradentes",
  "05-01": "Dia do Trabalho",
  "09-07": "Independência do Brasil",
  "10-12": "Nossa Senhora Aparecida",
  "11-02": "Finados",
  "11-15": "Proclamação da República",
  "11-20": "Dia da Consciência Negra",
  "12-25": "Natal",
};

function getEasterDateParts(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

function getGoodFridayKey(year: number): string {
  const easter = getEasterDateParts(year);
  const goodFridayUtc = new Date(
    Date.UTC(year, easter.month - 1, easter.day - 2),
  );
  const mm = String(goodFridayUtc.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(goodFridayUtc.getUTCDate()).padStart(2, "0");
  return `${mm}-${dd}`;
}

export function getHolidayNameByParts(
  year: number,
  month: number,
  day: number,
): string | null {
  const mmdd = `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (FIXED_NATIONAL_HOLIDAYS[mmdd]) {
    return FIXED_NATIONAL_HOLIDAYS[mmdd];
  }
  if (mmdd === getGoodFridayKey(year)) {
    return "Sexta-feira Santa";
  }
  return null;
}

export function getBrazilNationalHolidayName(date: Date): string | null {
  if (!date || isNaN(date.getTime())) return null;
  return getHolidayNameByParts(
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
  );
}

export function isBrazilNationalHoliday(date: Date): boolean {
  return Boolean(getBrazilNationalHolidayName(date));
}

export function formatLocalDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function extractDateKeyFromException(rawDate: unknown): string | null {
  if (!rawDate) return null;
  if (rawDate instanceof Date) {
    return isNaN(rawDate.getTime()) ? null : formatLocalDateKey(rawDate);
  }
  const str = String(rawDate).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }
  const parsed = new Date(str);
  if (isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BRAZIL_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(parsed);
}

export function getBrazilDatePartsFromIso(iso: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  dateKey: string;
} | null {
  const parsed = new Date(iso);
  if (isNaN(parsed.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BRAZIL_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(parsed);

  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const day = Number(parts.find((p) => p.type === "day")?.value);
  const rawHour = Number(parts.find((p) => p.type === "hour")?.value);
  const hour = rawHour === 24 ? 0 : rawHour;

  if (!year || !month || !day) return null;

  return {
    year,
    month,
    day,
    hour,
    dateKey: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

function parseAvailability(rawAvailability: any): {
  exceptions: any[];
} {
  let avail = rawAvailability;
  if (typeof avail === "string") {
    try {
      avail = JSON.parse(avail);
    } catch {
      avail = null;
    }
  }
  return {
    exceptions: Array.isArray(avail?.exceptions) ? avail.exceptions : [],
  };
}

function parseStartHourFromSlot(slot: string): number | null {
  if (!slot || typeof slot !== "string") return null;
  const rawStart = slot.split("-")[0].trim().replace("h", ":");
  const hourNum = parseInt(rawStart.split(":")[0], 10);
  return isNaN(hourNum) ? null : hourNum;
}

export function isRoomHolidayClosedOnDate(
  rawAvailability: any,
  date: Date,
): boolean {
  if (!isBrazilNationalHoliday(date)) return false;

  const targetDateKey = formatLocalDateKey(date);
  const { exceptions } = parseAvailability(rawAvailability);

  const exception = exceptions.find(
    (e: any) => extractDateKeyFromException(e?.date) === targetDateKey,
  );

  if (
    exception?.type === "extra" &&
    Array.isArray(exception.hours) &&
    exception.hours.length > 0
  ) {
    return false;
  }

  return true;
}

export function isBookingSlotBlockedByHoliday(
  rawAvailability: any,
  startTimeIso: string,
): { blocked: boolean; holidayName: string | null } {
  const parts = getBrazilDatePartsFromIso(startTimeIso);
  if (!parts) return { blocked: false, holidayName: null };

  const holidayName = getHolidayNameByParts(parts.year, parts.month, parts.day);
  if (!holidayName) return { blocked: false, holidayName: null };

  const { exceptions } = parseAvailability(rawAvailability);
  const exception = exceptions.find(
    (e: any) => extractDateKeyFromException(e?.date) === parts.dateKey,
  );

  if (exception?.type === "extra" && Array.isArray(exception.hours)) {
    const allowedHours = exception.hours
      .map((h: string) => parseStartHourFromSlot(h))
      .filter((h: number | null): h is number => h !== null);

    if (allowedHours.includes(parts.hour)) {
      return { blocked: false, holidayName };
    }
  }

  return { blocked: true, holidayName };
}