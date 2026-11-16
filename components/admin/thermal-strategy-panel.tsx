// components/admin/thermal-strategy-panel.tsx
"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { createClient } from "@/utils/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Building2,
  DoorOpen,
  Calendar as CalendarIcon,
  Clock,
  Layers,
  Loader2,
  Users,
  FileText,
  Tag,
} from "lucide-react";
import {
  format,
  subDays,
  addDays,
  startOfMonth,
  endOfMonth,
  subMonths,
  startOfDay,
  endOfDay,
  parseISO,
  eachDayOfInterval,
  getDay,
  getHours,
  isAfter,
} from "date-fns";

interface ShiftDef {
  id: "morning" | "afternoon" | "late_afternoon" | "night";
  label: string;
  shortLabel: string;
  startHour: number;
  endHour: number;
  hoursList: number[];
}

const SHIFTS_CONFIG: ShiftDef[] = [
  {
    id: "morning",
    label: "Manhã (08h–12h)",
    shortLabel: "Manhã",
    startHour: 8,
    endHour: 12,
    hoursList: [8, 9, 10, 11],
  },
  {
    id: "afternoon",
    label: "Tarde (12h–16h)",
    shortLabel: "Tarde",
    startHour: 12,
    endHour: 16,
    hoursList: [12, 13, 14, 15],
  },
  {
    id: "late_afternoon",
    label: "Fim de Tarde (16h–20h)",
    shortLabel: "Fim Tarde",
    startHour: 16,
    endHour: 20,
    hoursList: [16, 17, 18, 19],
  },
  {
    id: "night",
    label: "Noite (20h–23h)",
    shortLabel: "Noite",
    startHour: 20,
    endHour: 23,
    hoursList: [20, 21, 22],
  },
];

const WEEKDAYS_ORDER = [
  { dow: 1, short: "Seg", full: "Segunda-feira" },
  { dow: 2, short: "Ter", full: "Terça-feira" },
  { dow: 3, short: "Qua", full: "Quarta-feira" },
  { dow: 4, short: "Qui", full: "Quinta-feira" },
  { dow: 5, short: "Sex", full: "Sexta-feira" },
  { dow: 6, short: "Sáb", full: "Sábado" },
  { dow: 0, short: "Dom", full: "Domingo" },
];

const ALL_HOURS_LIST = [
  8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
];

type ContractFilterMode = "all" | "cohost_only" | "contracts_only";
type QuickRangePreset =
  | "next_7d"
  | "next_15d"
  | "next_30d"
  | "this_month"
  | "past_7d"
  | "past_30d"
  | "last_month"
  | "custom";

type ThermalTemperature = "hot" | "warm" | "cold";

interface CellRoomBreakdown {
  roomId: string;
  roomName: string;
  clinicName: string;
  tierLabel: string;
  hourlyRate: number;
  windowDurationHours: number;
  daysInPeriod: number;
  availableHours: number;
  occupiedHours: number;
  contractHours: number;
  packageHours: number;
  avulsoHours: number;
  freeHours: number;
  occupancyPct: number;
  hist30dAvailableHours: number;
  hist30dOccupiedHours: number;
  hist30dOccupancyPct: number;
  hist30dTemperature: ThermalTemperature;
  hasFixedContract: boolean;
  isCohostRoom: boolean;
  cohostName: string | null;
  contractNote: string | null;
}

interface ThermalCellStats {
  dow: number;
  dayShort: string;
  dayFull: string;
  colId: string;
  colLabel: string;
  windowDurationHours: number;
  occurrencesInPeriod: number;
  availableHours: number;
  occupiedHours: number;
  contractHours: number;
  packageHours: number;
  avulsoHours: number;
  freeHours: number;
  occupancyPct: number;
  contractSharePct: number;
  hist30dAvailableHours: number;
  hist30dOccupiedHours: number;
  hist30dContractHours: number;
  hist30dRentedHours: number;
  hist30dOccupancyPct: number;
  hist30dTemperature: ThermalTemperature;
  estimatedRevenueBrl: number;
  idleOpportunityBrl: number;
  status: "closed" | "contract_locked" | "hot" | "warm" | "cold";
  specialistsNames: string[];
  roomBreakdowns: CellRoomBreakdown[];
}

function normalizeTier(tier?: string | null): "start" | "vip" | "master" {
  const t = (tier || "start").toLowerCase().trim();
  if (t.includes("master") || t.includes("premium")) return "master";
  if (t.includes("vip")) return "vip";
  return "start";
}

function formatTierLabel(tier: "start" | "vip" | "master"): string {
  if (tier === "master") return "Premium";
  if (tier === "vip") return "VIP";
  return "Basic";
}

function resolveRoomHourlyRate(room: any): number {
  try {
    if (room?.modalities) {
      const parsed =
        typeof room.modalities === "string"
          ? JSON.parse(room.modalities)
          : room.modalities;
      const candidates = [
        parsed?.hourly?.price,
        parsed?.hourlyPrice,
        parsed?.price_per_hour,
        parsed?.price,
      ];
      for (const c of candidates) {
        const val = Number(c);
        if (!isNaN(val) && val > 0 && val <= 250) return val;
      }
    }
    if (room?.address_details) {
      const addr =
        typeof room.address_details === "string"
          ? JSON.parse(room.address_details)
          : room.address_details;
      const addrPrice = Number(addr?.pricing?.hourly);
      if (!isNaN(addrPrice) && addrPrice > 0 && addrPrice <= 250) {
        return addrPrice;
      }
    }
  } catch {}
  const t = normalizeTier(room?.tier);
  if (t === "master") return 60;
  if (t === "vip") return 41.13;
  return 33.38;
}

function calculateSlotUnits(startIso: string, endIso: string): number {
  const diffMinutes =
    (new Date(endIso).getTime() - new Date(startIso).getTime()) / (1000 * 60);
  if (diffMinutes <= 0) return 1;
  if (diffMinutes <= 65) return 1;
  return Math.max(1, Math.round(diffMinutes / 60));
}

function classifyTemperature(occPct: number): ThermalTemperature {
  if (occPct >= 65) return "hot";
  if (occPct >= 35) return "warm";
  return "cold";
}

function getRoomOpenHoursOnDate(room: any, dateObj: Date): Set<number> {
  const openHours = new Set<number>();
  const dateIso = format(dateObj, "yyyy-MM-dd");

  const blockedDates = Array.isArray(room?.blocked_dates)
    ? room.blocked_dates
    : [];
  if (blockedDates.includes(dateIso)) {
    return openHours;
  }

  let availability = room?.availability;
  if (typeof availability === "string") {
    try {
      availability = JSON.parse(availability);
    } catch {
      availability = null;
    }
  }

  const dow = getDay(dateObj);
  const defaultWeekdayHours = [
    8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 21,
  ];

  if (availability && Array.isArray(availability.weekConfig)) {
    const dayCfg = availability.weekConfig.find(
      (w: any) => Number(w.day) === dow,
    );
    if (dayCfg && dayCfg.enabled) {
      if (dayCfg.rentalType === "hourly") {
        if (
          Array.isArray(dayCfg.availableHours) &&
          dayCfg.availableHours.length > 0
        ) {
          dayCfg.availableHours.forEach((slotStr: string) => {
            const h = parseInt(String(slotStr).split(/[:h-]/)[0], 10);
            if (!isNaN(h) && h >= 7 && h <= 22) openHours.add(h);
          });
        } else {
          defaultWeekdayHours.forEach((h) => openHours.add(h));
        }
      } else if (dayCfg.rentalType === "shift") {
        const shifts = Array.isArray(dayCfg.selectedShifts)
          ? dayCfg.selectedShifts
          : [];
        if (shifts.includes("morning"))
          [8, 9, 10, 11].forEach((h) => openHours.add(h));
        if (shifts.includes("afternoon"))
          [13, 14, 15, 16, 17].forEach((h) => openHours.add(h));
        if (shifts.includes("night"))
          [18, 19, 20, 21].forEach((h) => openHours.add(h));
      }
    }

    if (Array.isArray(availability.exceptions)) {
      const targetDateStr = dateObj.toDateString();
      const ex = availability.exceptions.find(
        (e: any) =>
          e?.date && new Date(e.date).toDateString() === targetDateStr,
      );
      if (ex) {
        if (ex.type === "block") {
          if (ex.isFullDay) {
            openHours.clear();
          } else if (Array.isArray(ex.hours)) {
            ex.hours.forEach((slotStr: string) => {
              const h = parseInt(String(slotStr).split(/[:h-]/)[0], 10);
              if (!isNaN(h)) openHours.delete(h);
            });
          }
        } else if (ex.type === "extra" && Array.isArray(ex.hours)) {
          ex.hours.forEach((slotStr: string) => {
            const h = parseInt(String(slotStr).split(/[:h-]/)[0], 10);
            if (!isNaN(h) && h >= 7 && h <= 22) openHours.add(h);
          });
        }
      }
    }
  } else {
    if (dow >= 1 && dow <= 5) {
      [8, 9, 10, 11, 13, 14, 15, 16, 17, 18].forEach((h) => openHours.add(h));
    } else if (dow === 6) {
      [8, 9, 10, 11].forEach((h) => openHours.add(h));
    }
  }

  return openHours;
}

function summarizeRoomWeeklySubleaseSchedule(room: any): {
  weeklyOpenHours: number;
  daysSummary: string;
} {
  let availability = room?.availability;
  if (typeof availability === "string") {
    try {
      availability = JSON.parse(availability);
    } catch {
      availability = null;
    }
  }

  if (!availability || !Array.isArray(availability.weekConfig)) {
    return {
      weeklyOpenHours: 54,
      daysSummary: "Seg a Sex (10h/dia) • Sáb (4h)",
    };
  }

  let totalWeekly = 0;
  const parts: string[] = [];

  WEEKDAYS_ORDER.forEach((wd) => {
    const dayCfg = availability.weekConfig.find(
      (w: any) => Number(w.day) === wd.dow,
    );
    if (dayCfg && dayCfg.enabled) {
      const uniqueHours = new Set<number>();
      if (Array.isArray(dayCfg.availableHours)) {
        dayCfg.availableHours.forEach((s: string) => {
          const h = parseInt(String(s).split(/[:h-]/)[0], 10);
          if (!isNaN(h)) uniqueHours.add(h);
        });
      }
      const count = uniqueHours.size > 0 ? uniqueHours.size : 9;
      if (count > 0) {
        totalWeekly += count;
        parts.push(`${wd.short} (${count}h)`);
      }
    }
  });

  return {
    weeklyOpenHours: totalWeekly,
    daysSummary:
      parts.length > 0 ? parts.join(" • ") : "Nenhum dia aberto p/ sublocar",
  };
}

function getContractCoveredHoursOnDate(
  roomContracts: any[],
  dateObj: Date,
  openHours: Set<number>,
): { hours: Set<number>; contractNotes: string[] } {
  const covered = new Set<number>();
  const notes: string[] = [];
  if (!roomContracts || roomContracts.length === 0 || openHours.size === 0) {
    return { hours: covered, contractNotes: notes };
  }

  const dateIso = format(dateObj, "yyyy-MM-dd");
  const dow = getDay(dateObj);

  roomContracts.forEach((c: any) => {
    if (c.status !== "active" && c.status !== "pending_signature") return;
    if (c.start_date && dateIso < String(c.start_date).slice(0, 10)) return;
    if (c.end_date && dateIso > String(c.end_date).slice(0, 10)) return;

    const cType = String(c.contract_type || "").toLowerCase();
    const specName = c.specialist_name || "Locatário Fixo";

    if (cType.includes("monthly_exclusive")) {
      if (c.allow_sublease) {
        notes.push(`Coanfitrião (${specName})`);
        return;
      } else {
        openHours.forEach((h) => covered.add(h));
        notes.push(`Sala Exclusiva (${specName})`);
        return;
      }
    }

    let sched = c.schedule_config;
    if (typeof sched === "string") {
      try {
        sched = JSON.parse(sched);
      } catch {
        sched = null;
      }
    }

    if (sched && typeof sched === "object") {
      let matchedAnyHour = false;

      if (
        Array.isArray(sched.scheduleRules) &&
        sched.scheduleRules.length > 0
      ) {
        sched.scheduleRules.forEach((rule: any) => {
          if (Number(rule.dayOfWeek) !== dow) return;
          const sH = Number(rule.startHour ?? 8);
          const eH = Number(rule.endHour ?? 20);
          for (let h = sH; h < eH; h++) {
            if (openHours.has(h)) {
              covered.add(h);
              matchedAnyHour = true;
            }
          }
        });
        if (matchedAnyHour) {
          notes.push(`Turno Fixo (${specName})`);
        }
        return;
      }

      if (sched.day_hours && typeof sched.day_hours === "object") {
        const dayArr = sched.day_hours[String(dow)];
        if (Array.isArray(dayArr) && dayArr.length > 0) {
          dayArr.map(Number).forEach((h: number) => {
            if (openHours.has(h)) {
              covered.add(h);
              matchedAnyHour = true;
            }
          });
          if (matchedAnyHour) {
            notes.push(`Turno Fixo (${specName})`);
          }
          return;
        }
      }

      const daysArray = Array.isArray(sched.daysOfWeek)
        ? sched.daysOfWeek.map(Number)
        : Array.isArray(sched.days)
          ? sched.days.map(Number)
          : Array.isArray(sched.weekdays)
            ? sched.weekdays.map(Number)
            : null;

      if (daysArray && !daysArray.includes(dow)) return;

      if (
        sched.startHour !== undefined &&
        sched.endHour !== undefined &&
        !Array.isArray(sched.hours)
      ) {
        const sH = Number(sched.startHour ?? 8);
        const eH = Number(sched.endHour ?? 20);
        for (let h = sH; h < eH; h++) {
          if (openHours.has(h)) {
            covered.add(h);
            matchedAnyHour = true;
          }
        }
      }

      if (Array.isArray(sched.hours) && sched.hours.length > 0) {
        sched.hours.forEach((hRaw: any) => {
          const h = parseInt(String(hRaw).split(/[:h-]/)[0], 10);
          if (!isNaN(h) && openHours.has(h)) {
            covered.add(h);
            matchedAnyHour = true;
          }
        });
      }

      const shiftsArr = Array.isArray(sched.shifts)
        ? sched.shifts
        : typeof sched.shift === "string"
          ? [sched.shift]
          : [];

      if (!matchedAnyHour) {
        shiftsArr.forEach((sh: string) => {
          const s = String(sh).toLowerCase();
          if (s.includes("morn") || s.includes("manh")) {
            [8, 9, 10, 11].forEach((h) => {
              if (openHours.has(h)) {
                covered.add(h);
                matchedAnyHour = true;
              }
            });
          }
          if (s.includes("after") || s.includes("tard")) {
            [12, 13, 14, 15, 16, 17].forEach((h) => {
              if (openHours.has(h)) {
                covered.add(h);
                matchedAnyHour = true;
              }
            });
          }
          if (s.includes("night") || s.includes("noit")) {
            [18, 19, 20, 21, 22].forEach((h) => {
              if (openHours.has(h)) {
                covered.add(h);
                matchedAnyHour = true;
              }
            });
          }
        });
      }

      if (matchedAnyHour) {
        notes.push(`Turno Fixo (${specName})`);
      }
    }
  });

  return { hours: covered, contractNotes: Array.from(new Set(notes)) };
}

const formatBRL = (val: number) =>
  val.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export function AdminThermalStrategyPanel() {
  const [supabase] = useState(() => createClient());

  const [loading, setLoading] = useState(true);

  const [quickRange, setQuickRange] = useState<QuickRangePreset>("next_7d");
  const [startDate, setStartDate] = useState(() =>
    format(new Date(), "yyyy-MM-dd"),
  );
  const [endDate, setEndDate] = useState(() =>
    format(addDays(new Date(), 6), "yyyy-MM-dd"),
  );

  const [colorBasis, setColorBasis] = useState<"hist30d" | "selected">(
    "hist30d",
  );

  const [selectedClinicId, setSelectedClinicId] = useState<string>("all");
  const [selectedRoomId, setSelectedRoomId] = useState<string>("all");
  const [contractFilterMode, setContractFilterMode] =
    useState<ContractFilterMode>("all");

  const [matrixGranularity, setMatrixGranularity] = useState<
    "shifts" | "hourly"
  >("shifts");

  const [rooms, setRooms] = useState<any[]>([]);
  const [bookings, setBookings] = useState<any[]>([]);
  const [contracts, setContracts] = useState<any[]>([]);
  const [profilesMap, setProfilesMap] = useState(new Map<string, any>());

  const [selectedCell, setSelectedCell] = useState<ThermalCellStats | null>(
    null,
  );

  const isFutureOrPresentRange = useMemo(() => {
    const todayStr = format(new Date(), "yyyy-MM-dd");
    return endDate >= todayStr;
  }, [endDate]);

  const handleApplyQuickRange = (preset: QuickRangePreset) => {
    const now = new Date();
    setQuickRange(preset);
    if (preset === "next_7d") {
      setStartDate(format(now, "yyyy-MM-dd"));
      setEndDate(format(addDays(now, 6), "yyyy-MM-dd"));
    } else if (preset === "next_15d") {
      setStartDate(format(now, "yyyy-MM-dd"));
      setEndDate(format(addDays(now, 14), "yyyy-MM-dd"));
    } else if (preset === "next_30d") {
      setStartDate(format(now, "yyyy-MM-dd"));
      setEndDate(format(addDays(now, 29), "yyyy-MM-dd"));
    } else if (preset === "this_month") {
      setStartDate(format(startOfMonth(now), "yyyy-MM-dd"));
      setEndDate(format(endOfMonth(now), "yyyy-MM-dd"));
    } else if (preset === "past_7d") {
      setStartDate(format(subDays(now, 6), "yyyy-MM-dd"));
      setEndDate(format(now, "yyyy-MM-dd"));
    } else if (preset === "past_30d") {
      setStartDate(format(subDays(now, 29), "yyyy-MM-dd"));
      setEndDate(format(now, "yyyy-MM-dd"));
    } else if (preset === "last_month") {
      const lastM = subMonths(now, 1);
      setStartDate(format(startOfMonth(lastM), "yyyy-MM-dd"));
      setEndDate(format(endOfMonth(lastM), "yyyy-MM-dd"));
    }
  };

  const fetchThermalData = useCallback(async () => {
    setLoading(true);
    try {
      const now = new Date();
      const hist30Start = startOfDay(subDays(now, 29));
      const hist30End = endOfDay(now);

      const parsedStart = startDate ? parseISO(startDate) : now;
      const parsedEnd = endDate ? parseISO(endDate) : addDays(now, 6);

      const safeStart = startOfDay(
        isNaN(parsedStart.getTime()) ? now : parsedStart,
      );
      const safeEnd = endOfDay(
        isNaN(parsedEnd.getTime()) || parsedEnd < safeStart
          ? safeStart
          : parsedEnd,
      );

      const queryMinStart = safeStart < hist30Start ? safeStart : hist30Start;
      const queryMaxEnd = safeEnd > hist30End ? safeEnd : hist30End;

      const [roomsRes, bookingsRes, contractsRes] = await Promise.all([
        supabase
          .from("rooms")
          .select(
            "id, name, host_id, is_active, tier, modalities, address_details, availability, blocked_dates",
          )
          .order("name", { ascending: true }),
        supabase
          .from("bookings")
          .select(
            "id, start_time, end_time, status, room_id, user_id, contract_id, booking_origin, total_cost, agreed_value_brl",
          )
          .gte("start_time", queryMinStart.toISOString())
          .lte("start_time", queryMaxEnd.toISOString())
          .in("status", ["confirmed", "completed", "in_progress"]),
        supabase.from("room_contracts").select("*"),
      ]);

      const roomsList = (roomsRes.data || []).filter(
        (r: any) => r.is_active !== false,
      );
      const bookingsList = bookingsRes.data || [];
      const contractsList = contractsRes.data || [];

      const profileIds = Array.from(
        new Set(
          [
            ...roomsList.map((r: any) => r.host_id),
            ...bookingsList.map((b: any) => b.user_id),
            ...contractsList.map((c: any) => c.specialist_id),
          ].filter(Boolean),
        ),
      );

      const profilesRes =
        profileIds.length > 0
          ? await supabase
              .from("profiles")
              .select("id, full_name, email, specialty")
              .in("id", profileIds)
          : { data: [] as any[] };

      const pMap = new Map<string, any>();
      (profilesRes.data || []).forEach((p: any) => pMap.set(p.id, p));

      setRooms(roomsList);
      setBookings(bookingsList);
      setContracts(contractsList);
      setProfilesMap(pMap);
    } catch (err) {
      console.error("Erro ao carregar ocupação:", err);
    } finally {
      setLoading(false);
    }
  }, [supabase, startDate, endDate]);

  useEffect(() => {
    fetchThermalData();
  }, [fetchThermalData]);

  const roomContractMetaMap = useMemo(() => {
    const map = new Map<
      string,
      {
        hasAnyActiveContract: boolean;
        isCohostRoom: boolean;
        cohostContract: any | null;
        fixedSubContracts: any[];
      }
    >();

    rooms.forEach((r: any) => {
      const activeForRoom = contracts.filter(
        (c: any) =>
          c.room_id === r.id &&
          (c.status === "active" || c.status === "pending_signature") &&
          (!c.start_date || String(c.start_date).slice(0, 10) <= endDate) &&
          (!c.end_date || String(c.end_date).slice(0, 10) >= startDate),
      );

      const cohostC =
        activeForRoom.find(
          (c: any) =>
            c.contract_type === "monthly_exclusive" &&
            c.allow_sublease === true,
        ) || null;

      const fixedSubs = activeForRoom.filter(
        (c: any) =>
          !(
            c.contract_type === "monthly_exclusive" && c.allow_sublease === true
          ),
      );

      map.set(r.id, {
        hasAnyActiveContract: activeForRoom.length > 0,
        isCohostRoom: Boolean(cohostC),
        cohostContract: cohostC,
        fixedSubContracts: fixedSubs,
      });
    });

    return map;
  }, [rooms, contracts, startDate, endDate]);

  const clinicsList = useMemo(() => {
    const map = new Map<
      string,
      { id: string; name: string; roomsCount: number }
    >();
    rooms.forEach((r: any) => {
      const hostId = r.host_id || "fusion";
      const hostName =
        profilesMap.get(hostId)?.full_name || "Fusion Clinic (Sede)";
      const existing = map.get(hostId);
      if (existing) {
        existing.roomsCount += 1;
      } else {
        map.set(hostId, { id: hostId, name: hostName, roomsCount: 1 });
      }
    });
    return Array.from(map.values());
  }, [rooms, profilesMap]);

  const roomsInSelectedClinic = useMemo(() => {
    let base = rooms;
    if (selectedClinicId !== "all") {
      base = base.filter(
        (r: any) => (r.host_id || "fusion") === selectedClinicId,
      );
    }
    if (contractFilterMode === "cohost_only") {
      base = base.filter(
        (r: any) => roomContractMetaMap.get(r.id)?.isCohostRoom,
      );
    } else if (contractFilterMode === "contracts_only") {
      base = base.filter(
        (r: any) => roomContractMetaMap.get(r.id)?.hasAnyActiveContract,
      );
    }
    return base;
  }, [rooms, selectedClinicId, contractFilterMode, roomContractMetaMap]);

  const activeScopedRooms = useMemo(() => {
    if (selectedRoomId !== "all") {
      const found = roomsInSelectedClinic.filter(
        (r: any) => r.id === selectedRoomId,
      );
      if (found.length > 0) return found;
    }
    return roomsInSelectedClinic;
  }, [roomsInSelectedClinic, selectedRoomId]);

  const filterCounts = useMemo(() => {
    let cohostCount = 0;
    let contractRoomsCount = 0;
    rooms.forEach((r: any) => {
      if (
        selectedClinicId !== "all" &&
        (r.host_id || "fusion") !== selectedClinicId
      ) {
        return;
      }
      const meta = roomContractMetaMap.get(r.id);
      if (meta?.isCohostRoom) cohostCount += 1;
      if (meta?.hasAnyActiveContract) contractRoomsCount += 1;
    });
    return { cohostCount, contractRoomsCount };
  }, [rooms, selectedClinicId, roomContractMetaMap]);

  const thermalAnalysis = useMemo(() => {
    const now = new Date();
    const parsedStart = startDate ? parseISO(startDate) : now;
    const parsedEnd = endDate ? parseISO(endDate) : addDays(now, 6);
    const safeStart = startOfDay(
      isNaN(parsedStart.getTime()) ? now : parsedStart,
    );
    const safeEnd = endOfDay(
      isNaN(parsedEnd.getTime()) || parsedEnd < safeStart
        ? safeStart
        : parsedEnd,
    );

    const selectedDaysInterval = eachDayOfInterval({
      start: safeStart,
      end: safeEnd,
    });

    const hist30Start = startOfDay(subDays(now, 29));
    const hist30End = endOfDay(now);
    const hist30DaysInterval = eachDayOfInterval({
      start: hist30Start,
      end: hist30End,
    });

    const contractsByRoom = new Map<string, any[]>();
    contracts.forEach((c: any) => {
      if (!c.room_id) return;
      const list = contractsByRoom.get(c.room_id) || [];
      list.push(c);
      contractsByRoom.set(c.room_id, list);
    });

    const bookingsByRoomAndDate = new Map<string, any[]>();
    bookings.forEach((b: any) => {
      if (!b.room_id || !b.start_time) return;
      const dIso = format(parseISO(b.start_time), "yyyy-MM-dd");
      const key = `${b.room_id}_${dIso}`;
      const list = bookingsByRoomAndDate.get(key) || [];
      list.push(b);
      bookingsByRoomAndDate.set(key, list);
    });

    // Colunas: No modo "hourly", cada coluna representa exatamente 1 hora (col.hours = [h])
    const columns =
      matrixGranularity === "shifts"
        ? SHIFTS_CONFIG.map((sh) => ({
            id: sh.id,
            label: sh.label,
            shortLabel: sh.shortLabel,
            hours: sh.hoursList,
          }))
        : ALL_HOURS_LIST.map((h) => ({
            id: `h_${h}`,
            label: `${String(h).padStart(2, "0")}h às ${String(h + 1).padStart(2, "0")}h (1h)`,
            shortLabel: `${String(h).padStart(2, "0")}h–${String(h + 1).padStart(2, "0")}h`,
            hours: [h],
          }));

    const dowOccurrences = new Map<number, number>();
    WEEKDAYS_ORDER.forEach((w) => dowOccurrences.set(w.dow, 0));
    selectedDaysInterval.forEach((d) => {
      const dow = getDay(d);
      dowOccurrences.set(dow, (dowOccurrences.get(dow) || 0) + 1);
    });

    const evaluateRoomDayHours = (r: any, d: Date) => {
      const dateIso = format(d, "yyyy-MM-dd");
      const meta = roomContractMetaMap.get(r.id);
      const cohostContractId = meta?.cohostContract?.id || null;

      const openHoursSet = getRoomOpenHoursOnDate(r, d);
      const rContracts = contractsByRoom.get(r.id) || [];
      const { hours: contractCoveredSet, contractNotes } =
        getContractCoveredHoursOnDate(rContracts, d, openHoursSet);

      const dayBookings = bookingsByRoomAndDate.get(`${r.id}_${dateIso}`) || [];

      const hourState = new Map<number, "contract" | "package" | "avulso">();
      const hourSpecNames = new Map<number, string>();

      contractCoveredSet.forEach((h) => {
        hourState.set(h, "contract");
      });

      dayBookings.forEach((b: any) => {
        if (cohostContractId && b.contract_id === cohostContractId) {
          return;
        }

        const startD = parseISO(b.start_time);
        const startH = getHours(startD);
        const slots = calculateSlotUnits(
          b.start_time,
          b.end_time || b.start_time,
        );
        const endH = startH + slots;

        const isContractB = Boolean(
          b.contract_id ||
          (b.booking_origin && String(b.booking_origin).startsWith("contract")),
        );
        const isPkgB = Boolean(
          !isContractB &&
          ((b.booking_origin &&
            String(b.booking_origin).startsWith("wallet_")) ||
            (!b.booking_origin &&
              Number(b.agreed_value_brl || 0) === 0 &&
              Number(b.total_cost || 0) <= slots * 2)),
        );

        const bType: "contract" | "package" | "avulso" = isContractB
          ? "contract"
          : isPkgB
            ? "package"
            : "avulso";

        const specName =
          profilesMap.get(b.user_id)?.full_name || "Profissional";

        for (let h = startH; h < endH; h++) {
          hourSpecNames.set(h, specName);
          if (!hourState.has(h) || bType !== "contract") {
            hourState.set(h, bType);
          }
        }
      });

      return { openHoursSet, hourState, hourSpecNames, contractNotes };
    };

    const matrixRows = WEEKDAYS_ORDER.map((w) => {
      const occurrencesForThisDow = dowOccurrences.get(w.dow) || 0;

      const cells: ThermalCellStats[] = columns.map((col) => {
        const windowDuration = col.hours.length;
        const roomBreakdownsMap = new Map<string, CellRoomBreakdown>();

        activeScopedRooms.forEach((r: any) => {
          const hostId = r.host_id || "fusion";
          const clinicName =
            profilesMap.get(hostId)?.full_name || "Fusion Clinic";
          const meta = roomContractMetaMap.get(r.id);

          roomBreakdownsMap.set(r.id, {
            roomId: r.id,
            roomName: r.name,
            clinicName,
            tierLabel: formatTierLabel(normalizeTier(r.tier)),
            hourlyRate: resolveRoomHourlyRate(r),
            windowDurationHours: windowDuration,
            daysInPeriod: occurrencesForThisDow,
            availableHours: 0,
            occupiedHours: 0,
            contractHours: 0,
            packageHours: 0,
            avulsoHours: 0,
            freeHours: 0,
            occupancyPct: 0,
            hist30dAvailableHours: 0,
            hist30dOccupiedHours: 0,
            hist30dOccupancyPct: 0,
            hist30dTemperature: "cold",
            hasFixedContract: Boolean(meta?.hasAnyActiveContract),
            isCohostRoom: Boolean(meta?.isCohostRoom),
            cohostName: meta?.cohostContract?.specialist_name || null,
            contractNote: null,
          });
        });

        const specialistsSet = new Set<string>();
        let cellAvail = 0;
        let cellContractH = 0;
        let cellPackageH = 0;
        let cellAvulsoH = 0;
        let cellEstRev = 0;
        let cellIdleRev = 0;

        selectedDaysInterval.forEach((d) => {
          if (getDay(d) !== w.dow) return;

          activeScopedRooms.forEach((r: any) => {
            const rb = roomBreakdownsMap.get(r.id)!;
            const { openHoursSet, hourState, hourSpecNames, contractNotes } =
              evaluateRoomDayHours(r, d);

            if (contractNotes.length > 0 && !rb.contractNote) {
              rb.contractNote = contractNotes.join(" • ");
            }

            col.hours.forEach((h) => {
              const isOpen = openHoursSet.has(h) || hourState.has(h);
              if (!isOpen) return;

              rb.availableHours += 1;
              cellAvail += 1;

              const spec = hourSpecNames.get(h);
              if (spec) specialistsSet.add(spec);

              const occType = hourState.get(h);
              if (occType === "contract") {
                rb.occupiedHours += 1;
                rb.contractHours += 1;
                cellContractH += 1;
                cellEstRev += rb.hourlyRate;
              } else if (occType === "package") {
                rb.occupiedHours += 1;
                rb.packageHours += 1;
                cellPackageH += 1;
                cellEstRev += rb.hourlyRate;
              } else if (occType === "avulso") {
                rb.occupiedHours += 1;
                rb.avulsoHours += 1;
                cellAvulsoH += 1;
                cellEstRev += rb.hourlyRate * 1.15;
              } else {
                rb.freeHours += 1;
                cellIdleRev += rb.hourlyRate;
              }
            });
          });
        });

        let hist30Avail = 0;
        let hist30Contract = 0;
        let hist30Rented = 0;

        hist30DaysInterval.forEach((d) => {
          if (getDay(d) !== w.dow) return;

          activeScopedRooms.forEach((r: any) => {
            const rb = roomBreakdownsMap.get(r.id)!;
            const { openHoursSet, hourState } = evaluateRoomDayHours(r, d);

            col.hours.forEach((h) => {
              const isOpen = openHoursSet.has(h) || hourState.has(h);
              if (!isOpen) return;

              rb.hist30dAvailableHours += 1;
              hist30Avail += 1;

              const occType = hourState.get(h);
              if (occType === "contract") {
                rb.hist30dOccupiedHours += 1;
                hist30Contract += 1;
              } else if (occType === "package" || occType === "avulso") {
                rb.hist30dOccupiedHours += 1;
                hist30Rented += 1;
              }
            });
          });
        });

        const roomBreakdowns = Array.from(roomBreakdownsMap.values()).map(
          (rb) => {
            const rOccPct =
              rb.availableHours > 0
                ? Math.min(
                    100,
                    Math.round((rb.occupiedHours / rb.availableHours) * 100),
                  )
                : 0;
            const rHistPct =
              rb.hist30dAvailableHours > 0
                ? Math.min(
                    100,
                    Math.round(
                      (rb.hist30dOccupiedHours / rb.hist30dAvailableHours) *
                        100,
                    ),
                  )
                : 0;

            return {
              ...rb,
              occupancyPct: rOccPct,
              hist30dOccupancyPct: rHistPct,
              hist30dTemperature: classifyTemperature(rHistPct),
            };
          },
        );

        const cellOccupied = cellContractH + cellPackageH + cellAvulsoH;
        const cellFree = Math.max(0, cellAvail - cellOccupied);
        const occPct =
          cellAvail > 0
            ? Math.min(100, Math.round((cellOccupied / cellAvail) * 100))
            : 0;
        const contractSharePct =
          cellAvail > 0
            ? Math.min(100, Math.round((cellContractH / cellAvail) * 100))
            : 0;

        const hist30Occupied = hist30Contract + hist30Rented;
        const hist30Pct =
          hist30Avail > 0
            ? Math.min(100, Math.round((hist30Occupied / hist30Avail) * 100))
            : 0;
        const hist30Temp = classifyTemperature(hist30Pct);

        const referencePct = colorBasis === "hist30d" ? hist30Pct : occPct;

        let status: ThermalCellStats["status"] = "cold";
        if (cellAvail === 0 && hist30Avail === 0) {
          status = "closed";
        } else if (contractSharePct >= 70) {
          status = "contract_locked";
        } else if (referencePct >= 65) {
          status = "hot";
        } else if (referencePct >= 35) {
          status = "warm";
        } else {
          status = "cold";
        }

        return {
          dow: w.dow,
          dayShort: w.short,
          dayFull: w.full,
          colId: col.id,
          colLabel: col.label,
          windowDurationHours: windowDuration,
          occurrencesInPeriod: occurrencesForThisDow,
          availableHours: cellAvail,
          occupiedHours: cellOccupied,
          contractHours: cellContractH,
          packageHours: cellPackageH,
          avulsoHours: cellAvulsoH,
          freeHours: cellFree,
          occupancyPct: occPct,
          contractSharePct,
          hist30dAvailableHours: hist30Avail,
          hist30dOccupiedHours: hist30Occupied,
          hist30dContractHours: hist30Contract,
          hist30dRentedHours: hist30Rented,
          hist30dOccupancyPct: hist30Pct,
          hist30dTemperature: hist30Temp,
          estimatedRevenueBrl: cellEstRev,
          idleOpportunityBrl: cellIdleRev,
          status,
          specialistsNames: Array.from(specialistsSet),
          roomBreakdowns,
        };
      });

      return {
        dow: w.dow,
        dayShort: w.short,
        dayFull: w.full,
        occurrences: occurrencesForThisDow,
        cells,
      };
    });

    const roomSummaries = roomsInSelectedClinic.map((r: any) => {
      let avail = 0;
      let contractH = 0;
      let pkgH = 0;
      let avulsoH = 0;
      let freeH = 0;
      let hist30Avail = 0;
      let hist30Occ = 0;
      const hourlyRate = resolveRoomHourlyRate(r);
      const meta = roomContractMetaMap.get(r.id);
      const weeklyScheduleInfo = summarizeRoomWeeklySubleaseSchedule(r);

      matrixRows.forEach((row) => {
        row.cells.forEach((c) => {
          const rb = c.roomBreakdowns.find((x) => x.roomId === r.id);
          if (rb) {
            avail += rb.availableHours;
            contractH += rb.contractHours;
            pkgH += rb.packageHours;
            avulsoH += rb.avulsoHours;
            freeH += rb.freeHours;
            hist30Avail += rb.hist30dAvailableHours;
            hist30Occ += rb.hist30dOccupiedHours;
          }
        });
      });

      const occ = contractH + pkgH + avulsoH;
      const occPct =
        avail > 0 ? Math.min(100, Math.round((occ / avail) * 100)) : 0;
      const hist30Pct =
        hist30Avail > 0
          ? Math.min(100, Math.round((hist30Occ / hist30Avail) * 100))
          : 0;

      return {
        id: r.id,
        name: r.name,
        hostId: r.host_id || "fusion",
        clinicName:
          profilesMap.get(r.host_id || "fusion")?.full_name || "Fusion Clinic",
        tierLabel: formatTierLabel(normalizeTier(r.tier)),
        hourlyRate,
        availableHours: avail,
        occupiedHours: occ,
        contractHours: contractH,
        packageHours: pkgH,
        avulsoHours: avulsoH,
        freeHours: freeH,
        occupancyPct: occPct,
        hist30dOccupancyPct: hist30Pct,
        idleOpportunityBrl: freeH * hourlyRate,
        hasAnyActiveContract: Boolean(meta?.hasAnyActiveContract),
        isCohostRoom: Boolean(meta?.isCohostRoom),
        cohostName: meta?.cohostContract?.specialist_name || null,
        cohostSplitPct: Number(meta?.cohostContract?.cohost_split_pct || 80),
        fixedContractsCount: meta?.fixedSubContracts?.length || 0,
        fixedContractNames: (meta?.fixedSubContracts || [])
          .map((c: any) => c.specialist_name)
          .filter(Boolean),
        weeklyOpenHours: weeklyScheduleInfo.weeklyOpenHours,
        daysSummary: weeklyScheduleInfo.daysSummary,
      };
    });

    let totalAvail = 0;
    let totalOccupied = 0;
    let totalContract = 0;
    let totalPackage = 0;
    let totalAvulso = 0;
    let totalFree = 0;
    let totalIdleOpportunityBrl = 0;
    let totalHist30Avail = 0;
    let totalHist30Occupied = 0;

    const allOpenCells: ThermalCellStats[] = [];

    matrixRows.forEach((r) => {
      r.cells.forEach((c) => {
        totalAvail += c.availableHours;
        totalOccupied += c.occupiedHours;
        totalContract += c.contractHours;
        totalPackage += c.packageHours;
        totalAvulso += c.avulsoHours;
        totalFree += c.freeHours;
        totalIdleOpportunityBrl += c.idleOpportunityBrl;
        totalHist30Avail += c.hist30dAvailableHours;
        totalHist30Occupied += c.hist30dOccupiedHours;

        if (c.status !== "closed") {
          allOpenCells.push(c);
        }
      });
    });

    const overallOccupancyPct =
      totalAvail > 0
        ? Math.min(100, Math.round((totalOccupied / totalAvail) * 100))
        : 0;
    const overallContractPct =
      totalAvail > 0
        ? Math.min(100, Math.round((totalContract / totalAvail) * 100))
        : 0;
    const overallHist30Pct =
      totalHist30Avail > 0
        ? Math.min(
            100,
            Math.round((totalHist30Occupied / totalHist30Avail) * 100),
          )
        : 0;

    const promoCandidateCells = [...allOpenCells]
      .filter((c) => c.freeHours > 0 && c.hist30dTemperature === "cold")
      .sort(
        (a, b) =>
          a.hist30dOccupancyPct - b.hist30dOccupancyPct ||
          b.freeHours - a.freeHours,
      )
      .slice(0, 4);

    return {
      columns,
      matrixRows,
      roomSummaries,
      promoCandidateCells,
      totals: {
        totalAvail,
        totalOccupied,
        totalContract,
        totalPackage,
        totalAvulso,
        totalFree,
        overallOccupancyPct,
        overallContractPct,
        overallHist30Pct,
        totalIdleOpportunityBrl,
      },
    };
  }, [
    startDate,
    endDate,
    activeScopedRooms,
    roomsInSelectedClinic,
    contracts,
    bookings,
    profilesMap,
    matrixGranularity,
    roomContractMetaMap,
    colorBasis,
  ]);

  const getCellVisualStyle = (cell: ThermalCellStats) => {
    if (cell.status === "closed") {
      return "bg-slate-50/70 border-slate-200/60 border-dashed text-slate-300";
    }
    if (cell.status === "contract_locked") {
      return "bg-slate-900 border-slate-800 text-white hover:bg-slate-800";
    }
    if (cell.status === "hot") {
      return "bg-[#9A3C1D] border-[#7c2f15] text-white hover:bg-[#863318]";
    }
    if (cell.status === "warm") {
      return "bg-orange-100/90 border-orange-300 text-[#9A3C1D] hover:bg-orange-200/70";
    }
    return "bg-sky-50/85 border-sky-200/90 text-sky-950 hover:bg-sky-100/80";
  };

  const renderTemperatureBadge = (
    temp: ThermalTemperature,
    pct30d: number,
    isDarkBg: boolean,
  ) => {
    if (temp === "hot") {
      return (
        <span
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold ${
            isDarkBg
              ? "bg-black/25 text-amber-300"
              : "bg-orange-200/80 text-[#9A3C1D]"
          }`}
        >
          30d: {pct30d}% (Quente)
        </span>
      );
    }
    if (temp === "warm") {
      return (
        <span
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold ${
            isDarkBg
              ? "bg-white/15 text-orange-200"
              : "bg-amber-100 text-amber-900"
          }`}
        >
          30d: {pct30d}% (Morno)
        </span>
      );
    }
    return (
      <span
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold ${
          isDarkBg ? "bg-sky-400/20 text-sky-200" : "bg-sky-200/75 text-sky-900"
        }`}
      >
        30d: {pct30d}% (Frio • Promo)
      </span>
    );
  };

  const contractAndCohostRooms = useMemo(() => {
    return thermalAnalysis.roomSummaries.filter((rm) =>
      contractFilterMode === "cohost_only"
        ? rm.isCohostRoom
        : rm.hasAnyActiveContract,
    );
  }, [thermalAnalysis.roomSummaries, contractFilterMode]);

  return (
    <div className="bg-white rounded-2xl border border-slate-200/90 mb-8 overflow-hidden shadow-2xs print:break-inside-avoid">
      <div className="p-6 border-b border-slate-200/80 bg-[#FAF7F4]">
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-bold text-slate-900 tracking-tight">
              Mapa de Horários Quentes e Frios
            </h2>
            <p className="text-xs text-slate-500 mt-0.5 max-w-3xl">
              {isFutureOrPresentRange
                ? "Período selecionado (Presente/Futuro): Exibindo quantos horários já foram alugados nesta janela e comparando com o termômetro histórico dos últimos 30 dias."
                : "Período selecionado (Passado): Exibindo taxa de ocupação real e o termômetro histórico dos últimos 30 dias."}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap items-center bg-white p-1 rounded-xl border border-stone-200/90">
              {[
                { id: "next_7d", label: "Hoje + 7d" },
                { id: "next_15d", label: "Hoje + 15d" },
                { id: "next_30d", label: "Hoje + 30d" },
                { id: "this_month", label: "Este Mês" },
                { id: "past_7d", label: "Últ. 7d" },
                { id: "past_30d", label: "Últ. 30d" },
              ].map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() =>
                    handleApplyQuickRange(p.id as QuickRangePreset)
                  }
                  className={`px-2.5 py-1.5 rounded-lg text-[11px] font-semibold transition-all cursor-pointer ${
                    quickRange === p.id
                      ? "bg-slate-900 text-white"
                      : "text-slate-600 hover:text-slate-900"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <div className="flex items-center bg-white border border-stone-200/90 rounded-xl px-3 py-1.5">
              <CalendarIcon className="w-3.5 h-3.5 text-[#BF4B24] mr-2 shrink-0" />
              <input
                type="date"
                value={startDate}
                onChange={(e) => {
                  setQuickRange("custom");
                  setStartDate(e.target.value);
                }}
                className="bg-transparent border-0 text-xs font-semibold text-slate-800 outline-none w-28 tabular-nums"
              />
              <span className="text-slate-400 px-1.5 text-[11px]">até</span>
              <input
                type="date"
                value={endDate}
                onChange={(e) => {
                  setQuickRange("custom");
                  setEndDate(e.target.value);
                }}
                className="bg-transparent border-0 text-xs font-semibold text-slate-800 outline-none w-28 tabular-nums"
              />
            </div>
          </div>
        </div>

        <div className="mt-5 pt-4 border-t border-stone-200/80 flex flex-col xl:flex-row xl:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="flex flex-wrap items-center bg-white p-1 rounded-xl border border-stone-200">
              <button
                type="button"
                onClick={() => {
                  setContractFilterMode("all");
                  setSelectedRoomId("all");
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  contractFilterMode === "all"
                    ? "bg-slate-900 text-white"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                Todas as Salas ({rooms.length})
              </button>

              <button
                type="button"
                onClick={() => {
                  setContractFilterMode(
                    contractFilterMode === "cohost_only"
                      ? "all"
                      : "cohost_only",
                  );
                  setSelectedRoomId("all");
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
                  contractFilterMode === "cohost_only"
                    ? "bg-[#BF4B24] text-white"
                    : "text-slate-700 hover:bg-orange-50 hover:text-[#BF4B24]"
                }`}
              >
                <Users className="w-3.5 h-3.5" />
                <span>Salas c/ Coanfitrião ({filterCounts.cohostCount})</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setContractFilterMode(
                    contractFilterMode === "contracts_only"
                      ? "all"
                      : "contracts_only",
                  );
                  setSelectedRoomId("all");
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
                  contractFilterMode === "contracts_only"
                    ? "bg-slate-900 text-white"
                    : "text-slate-700 hover:bg-slate-100"
                }`}
              >
                <FileText className="w-3.5 h-3.5" />
                <span>
                  Salas c/ Contrato Fixo ({filterCounts.contractRoomsCount})
                </span>
              </button>
            </div>

            <div className="flex items-center gap-2 bg-white border border-stone-200 rounded-xl px-3 h-10">
              <Building2 className="w-4 h-4 text-[#BF4B24] shrink-0" />
              <span className="text-[11px] font-semibold text-slate-400">
                Clínica:
              </span>
              <select
                value={selectedClinicId}
                onChange={(e) => {
                  setSelectedClinicId(e.target.value);
                  setSelectedRoomId("all");
                }}
                className="bg-transparent text-xs font-bold text-slate-900 outline-none cursor-pointer pr-2"
              >
                <option value="all">
                  Todas as Clínicas ({clinicsList.length})
                </option>
                {clinicsList.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.roomsCount} salas)
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2 bg-white border border-stone-200 rounded-xl px-3 h-10">
              <DoorOpen className="w-4 h-4 text-slate-700 shrink-0" />
              <span className="text-[11px] font-semibold text-slate-400">
                Sala:
              </span>
              <select
                value={selectedRoomId}
                onChange={(e) => setSelectedRoomId(e.target.value)}
                className="bg-transparent text-xs font-bold text-slate-900 outline-none cursor-pointer pr-2"
              >
                <option value="all">
                  Todas ({roomsInSelectedClinic.length} salas)
                </option>
                {roomsInSelectedClinic.map((r: any) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({formatTierLabel(normalizeTier(r.tier))})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 self-start xl:self-auto">
            <div className="flex bg-white p-1 rounded-xl border border-stone-200">
              <button
                type="button"
                onClick={() => setColorBasis("hist30d")}
                title="Colore os blocos com base nos últimos 30 dias para destacar horários quentes e frios"
                className={`px-2.5 py-1.5 rounded-lg text-[11px] font-semibold transition-all flex items-center gap-1 cursor-pointer ${
                  colorBasis === "hist30d"
                    ? "bg-[#BF4B24] text-white"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                Termômetro 30d (Quente/Frio)
              </button>
              <button
                type="button"
                onClick={() => setColorBasis("selected")}
                title="Colore os blocos apenas pela ocupação já reservada nas datas selecionadas"
                className={`px-2.5 py-1.5 rounded-lg text-[11px] font-semibold transition-all cursor-pointer ${
                  colorBasis === "selected"
                    ? "bg-slate-900 text-white"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                Cor do Período
              </button>
            </div>

            <div className="flex bg-white p-1 rounded-xl border border-stone-200">
              <button
                type="button"
                onClick={() => setMatrixGranularity("shifts")}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                  matrixGranularity === "shifts"
                    ? "bg-slate-900 text-white"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
                Por Turnos
              </button>
              <button
                type="button"
                onClick={() => setMatrixGranularity("hourly")}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                  matrixGranularity === "hourly"
                    ? "bg-slate-900 text-white"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                <Clock className="w-3.5 h-3.5" />
                Hora a Hora (1h por janela)
              </button>
            </div>
          </div>
        </div>
      </div>

      {thermalAnalysis.promoCandidateCells.length > 0 && (
        <div className="px-6 py-3.5 bg-sky-50/70 border-b border-sky-200/80 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex items-start sm:items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-sky-600 text-white flex items-center justify-center shrink-0">
              <Tag className="w-4 h-4" />
            </div>
            <div>
              <span className="text-[11px] font-extrabold uppercase tracking-wider text-sky-900 block">
                Sugestão de Promoção (Horários Frios nos Últimos 30 Dias + Vagos
                no Período)
              </span>
              <p className="text-xs text-sky-800">
                Estes horários tiveram baixa procura nos últimos 30 dias e estão
                com vagas abertas no período selecionado:
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {thermalAnalysis.promoCandidateCells.map((c) => (
              <button
                key={`${c.dow}_${c.colId}`}
                type="button"
                onClick={() => setSelectedCell(c)}
                className="px-3 py-1.5 rounded-xl bg-white hover:bg-sky-100 border border-sky-200 text-xs font-bold text-sky-950 flex items-center gap-1.5 shadow-2xs transition-colors cursor-pointer"
              >
                <span>
                  {c.dayShort} • {c.colLabel.replace(" (1h)", "")}
                </span>
                <span className="text-[10px] font-semibold text-sky-700 bg-sky-50 px-1.5 py-0.5 rounded">
                  30d: {c.hist30dOccupancyPct}% • {c.freeHours} livre(s)
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {contractFilterMode !== "all" && (
        <div className="p-6 bg-stone-50/90 border-b border-slate-200 space-y-4 animate-in fade-in duration-200">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-wider text-[#BF4B24] block">
                {contractFilterMode === "cohost_only"
                  ? "Estoque de Sublocação de Coanfitriões"
                  : "Capacidade e Horas Livres em Salas com Contrato Fixo"}
              </span>
              <h3 className="text-sm sm:text-base font-bold text-slate-900">
                {contractFilterMode === "cohost_only"
                  ? `Salas com Coanfitrião Ativo (${contractAndCohostRooms.length}) — Demanda de Horas para Alugar`
                  : `Salas com Contrato / Turno Fixo (${contractAndCohostRooms.length}) — Horas Disponíveis dentro de Cada Sala`}
              </h3>
            </div>

            <div className="flex items-center gap-3 text-xs tabular-nums">
              <span className="px-3 py-1.5 rounded-xl bg-white border border-slate-200 font-semibold text-slate-700">
                Total Livre p/ Alugar nestas salas:{" "}
                <strong className="text-[#BF4B24]">
                  {thermalAnalysis.totals.totalFree}h
                </strong>{" "}
                (R$ {formatBRL(thermalAnalysis.totals.totalIdleOpportunityBrl)})
              </span>
            </div>
          </div>

          {contractAndCohostRooms.length === 0 ? (
            <div className="p-8 rounded-2xl bg-white border border-slate-200 text-center text-xs text-slate-500">
              Nenhuma sala com{" "}
              {contractFilterMode === "cohost_only"
                ? "Coanfitrião ativo"
                : "Contrato Fixo vigente"}{" "}
              encontrada neste filtro.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 tabular-nums">
              {contractAndCohostRooms.map((rm) => {
                const isSelected = selectedRoomId === rm.id;
                const subleasedOrBookedHours = rm.packageHours + rm.avulsoHours;
                const freeSharePct =
                  rm.availableHours > 0
                    ? Math.round((rm.freeHours / rm.availableHours) * 100)
                    : 0;

                return (
                  <div
                    key={rm.id}
                    onClick={() =>
                      setSelectedRoomId(isSelected ? "all" : rm.id)
                    }
                    className={`p-4 rounded-2xl border transition-all cursor-pointer flex flex-col justify-between gap-3.5 ${
                      isSelected
                        ? "bg-white border-[#BF4B24] ring-2 ring-[#BF4B24]/20 shadow-md"
                        : "bg-white border-slate-200/90 hover:border-slate-300 shadow-2xs"
                    }`}
                  >
                    <div className="space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <h4 className="text-sm font-bold text-slate-900">
                              {rm.name}
                            </h4>
                            <Badge className="bg-slate-100 text-slate-700 border-0 text-[10px] font-semibold">
                              {rm.tierLabel}
                            </Badge>
                          </div>
                          <p className="text-[11px] text-slate-500">
                            {rm.clinicName} • R$ {formatBRL(rm.hourlyRate)}/h
                          </p>
                        </div>

                        {rm.isCohostRoom ? (
                          <Badge className="bg-emerald-50 text-emerald-800 border border-emerald-200 text-[10px] font-bold shrink-0">
                            Co-Host ({rm.cohostSplitPct}%)
                          </Badge>
                        ) : (
                          <Badge className="bg-slate-900 text-white border-0 text-[10px] font-semibold shrink-0">
                            {rm.fixedContractsCount} Turno(s) Fixo(s)
                          </Badge>
                        )}
                      </div>

                      <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-100 text-[11px] space-y-1">
                        {rm.isCohostRoom && (
                          <div className="flex items-center justify-between text-slate-700">
                            <span className="text-slate-500">Coanfitrião:</span>
                            <strong className="text-slate-900 truncate max-w-[170px]">
                              {rm.cohostName}
                            </strong>
                          </div>
                        )}
                        {rm.fixedContractNames.length > 0 && (
                          <div className="flex items-center justify-between text-slate-700">
                            <span className="text-slate-500">
                              Contratos Fixos:
                            </span>
                            <strong className="text-slate-900 truncate max-w-[170px]">
                              {rm.fixedContractNames.join(", ")}
                            </strong>
                          </div>
                        )}
                        <div className="flex items-start justify-between gap-2 pt-1 border-t border-slate-200/60 text-[10px] text-slate-500">
                          <span className="shrink-0">Vitrine Semanal:</span>
                          <span className="font-semibold text-slate-700 text-right">
                            {rm.daysSummary}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2.5">
                      <div className="grid grid-cols-3 gap-2 text-center">
                        <div className="p-2 rounded-xl bg-slate-50 border border-slate-100">
                          <span className="text-[10px] text-slate-400 block">
                            {rm.isCohostRoom
                              ? "Abertas p/ Sublocar"
                              : "Horas Abertas"}
                          </span>
                          <strong className="text-xs font-bold text-slate-800">
                            {rm.availableHours}h
                          </strong>
                        </div>

                        <div className="p-2 rounded-xl bg-slate-50 border border-slate-100">
                          <span className="text-[10px] text-slate-400 block">
                            Já Alugadas
                          </span>
                          <strong className="text-xs font-bold text-slate-800">
                            {rm.contractHours + subleasedOrBookedHours}h
                          </strong>
                        </div>

                        <div className="p-2 rounded-xl bg-orange-50/80 border border-orange-200/80">
                          <span className="text-[10px] font-bold text-[#BF4B24] block">
                            Livres p/ Alugar
                          </span>
                          <strong className="text-sm font-black text-[#BF4B24]">
                            {rm.freeHours}h
                          </strong>
                        </div>
                      </div>

                      <div className="space-y-1">
                        <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden flex">
                          {rm.availableHours > 0 && (
                            <>
                              <div
                                title={`Contratos Fixos: ${rm.contractHours}h`}
                                className="h-full bg-slate-900"
                                style={{
                                  width: `${(rm.contractHours / rm.availableHours) * 100}%`,
                                }}
                              />
                              <div
                                title={`Alugadas (Pass+ / Avulso): ${subleasedOrBookedHours}h`}
                                className="h-full bg-emerald-600"
                                style={{
                                  width: `${(subleasedOrBookedHours / rm.availableHours) * 100}%`,
                                }}
                              />
                            </>
                          )}
                        </div>

                        <div className="flex items-center justify-between text-[10px] text-slate-500">
                          <span>
                            {rm.freeHours > 0 ? (
                              <strong className="text-slate-800">
                                {freeSharePct}% livre • Hist. 30d:{" "}
                                {rm.hist30dOccupancyPct}%
                              </strong>
                            ) : (
                              "100% preenchida no período"
                            )}
                          </span>
                          <span className="font-bold text-[#BF4B24]">
                            Potencial: R$ {formatBRL(rm.idleOpportunityBrl)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* CARDS DE SELEÇÃO RÁPIDA DE SALA */}
      <div className="px-6 py-4 bg-slate-50/70 border-b border-slate-200/80">
        <div className="flex items-stretch gap-3 overflow-x-auto pb-1 no-scrollbar">
          <button
            type="button"
            onClick={() => setSelectedRoomId("all")}
            className={`min-w-[205px] p-3.5 rounded-xl border text-left transition-all shrink-0 cursor-pointer ${
              selectedRoomId === "all"
                ? "bg-slate-900 text-white border-slate-900"
                : "bg-white text-slate-800 border-slate-200 hover:border-slate-300"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider opacity-75">
                Consolidado ({roomsInSelectedClinic.length} salas)
              </span>
              <span className="text-[10px] font-bold tabular-nums bg-white/15 px-1.5 py-0.5 rounded">
                30d: {thermalAnalysis.totals.overallHist30Pct}%
              </span>
            </div>
            <p className="text-xs font-bold mt-1 truncate">
              {contractFilterMode === "cohost_only"
                ? "Salas com Coanfitrião"
                : contractFilterMode === "contracts_only"
                  ? "Salas com Contrato Fixo"
                  : selectedClinicId === "all"
                    ? "Todas as Salas"
                    : clinicsList.find((c) => c.id === selectedClinicId)?.name}
            </p>
            <div className="mt-2 flex items-center justify-between text-[10px] opacity-85 tabular-nums">
              <span>Alugados: {thermalAnalysis.totals.totalOccupied}h</span>
              <span>Livres: {thermalAnalysis.totals.totalFree}h</span>
            </div>
          </button>

          {thermalAnalysis.roomSummaries.map((rm) => {
            const isSelected = selectedRoomId === rm.id;
            return (
              <button
                key={rm.id}
                type="button"
                onClick={() => setSelectedRoomId(isSelected ? "all" : rm.id)}
                className={`min-w-[220px] p-3.5 rounded-xl border text-left transition-all shrink-0 cursor-pointer ${
                  isSelected
                    ? "bg-[#BF4B24] text-white border-[#BF4B24]"
                    : "bg-white text-slate-800 border-slate-200 hover:border-slate-300"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`text-[10px] font-medium truncate ${
                      isSelected ? "text-white/85" : "text-slate-400"
                    }`}
                  >
                    {rm.clinicName} • {rm.tierLabel}
                  </span>
                  <span className="text-[10px] font-bold tabular-nums">
                    30d: {rm.hist30dOccupancyPct}%
                  </span>
                </div>

                <div className="flex items-center justify-between gap-1.5 mt-1">
                  <p className="text-xs font-bold truncate">{rm.name}</p>
                  {rm.isCohostRoom && (
                    <span
                      className={`text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0 ${
                        isSelected
                          ? "bg-black/25 text-white"
                          : "bg-emerald-50 text-emerald-800"
                      }`}
                    >
                      Co-Host
                    </span>
                  )}
                </div>

                <div
                  className={`mt-2 flex items-center justify-between text-[10px] tabular-nums ${
                    isSelected ? "text-white/90" : "text-slate-500"
                  }`}
                >
                  <span>Alugados: {rm.occupiedHours}h</span>
                  <span
                    className={
                      !isSelected && rm.freeHours > 0
                        ? "font-bold text-[#BF4B24]"
                        : ""
                    }
                  >
                    Livres: {rm.freeHours}h
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* RESUMO NUMÉRICO */}
      <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-slate-200 border-b border-slate-200 bg-white tabular-nums">
        <div className="p-4 sm:px-6">
          <span className="text-[11px] font-medium text-slate-500 block">
            Horários Já Alugados no Período
          </span>
          <p className="text-xl font-bold text-slate-900 mt-1">
            {thermalAnalysis.totals.totalOccupied}h{" "}
            <span className="text-xs font-normal text-slate-400">
              de {thermalAnalysis.totals.totalAvail}h (
              {thermalAnalysis.totals.overallOccupancyPct}%)
            </span>
          </p>
        </div>

        <div className="p-4 sm:px-6">
          <span className="text-[11px] font-medium text-slate-500 block">
            Termômetro Histórico (Últimos 30 Dias)
          </span>
          <p className="text-xl font-bold text-[#BF4B24] mt-1">
            {thermalAnalysis.totals.overallHist30Pct}%{" "}
            <span className="text-xs font-normal text-slate-500">
              de ocupação média nos últimos 30d
            </span>
          </p>
        </div>

        <div className="p-4 sm:px-6">
          <span className="text-[11px] font-medium text-slate-500 block">
            Divisão dos Alugados no Período
          </span>
          <p className="text-xl font-bold text-slate-900 mt-1">
            {thermalAnalysis.totals.totalContract}h Fixo{" "}
            <span className="text-xs font-normal text-slate-500">
              •{" "}
              {thermalAnalysis.totals.totalPackage +
                thermalAnalysis.totals.totalAvulso}
              h Avulso/Pass+
            </span>
          </p>
        </div>

        <div className="p-4 sm:px-6">
          <span className="text-[11px] font-medium text-slate-500 block">
            Horários Livres p/ Alugar no Período
          </span>
          <p className="text-xl font-bold text-emerald-700 mt-1">
            {thermalAnalysis.totals.totalFree}h{" "}
            <span className="text-xs font-normal text-slate-500">
              (R$ {formatBRL(thermalAnalysis.totals.totalIdleOpportunityBrl)})
            </span>
          </p>
        </div>
      </div>

      {/* MATRIZ PRINCIPAL */}
      <div className="p-6 relative">
        {loading && (
          <div className="absolute inset-0 bg-white/70 backdrop-blur-xs z-20 flex items-center justify-center">
            <Loader2 className="w-7 h-7 animate-spin text-[#BF4B24]" />
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex flex-wrap items-center gap-3 text-[11px] font-medium text-slate-600">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-xs bg-slate-900" />
              Contrato / Turno Fixo
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-xs bg-[#9A3C1D]" />
              Horário Quente (≥65% nos últimos 30d)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-xs bg-orange-200 border border-orange-300" />
              Horário Morno {"(35%–64% nos últimos 30d)"}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-xs bg-sky-100 border border-sky-300" />
              Horário Frio {"(<35% nos últimos 30d — Ideal p/ Promoção)"}
            </span>
          </div>

          <span className="text-[11px] text-slate-500 font-medium">
            {matrixGranularity === "hourly"
              ? "Cada coluna representa exatamente 1 hora de relógio (ex: 08h às 09h = 1h)"
              : "Clique em qualquer bloco para ver os horários alugados vs. termômetro de 30 dias por sala"}
          </span>
        </div>

        <div className="overflow-x-auto pb-2">
          <div
            className={
              matrixGranularity === "shifts"
                ? "min-w-[720px]"
                : "min-w-[1320px]"
            }
          >
            <div
              className="grid gap-2 mb-2"
              style={{
                gridTemplateColumns:
                  matrixGranularity === "shifts"
                    ? "115px repeat(4, minmax(140px, 1fr))"
                    : "100px repeat(15, minmax(76px, 1fr))",
              }}
            >
              <div className="text-[10px] font-semibold uppercase text-slate-400 self-end pb-1">
                Dia da Semana
              </div>
              {thermalAnalysis.columns.map((col) => (
                <div
                  key={col.id}
                  className="text-center text-[10px] font-bold text-slate-700 uppercase tracking-wider bg-slate-100 py-2 rounded-lg"
                >
                  {matrixGranularity === "shifts" ? (
                    col.label
                  ) : (
                    <div className="flex flex-col items-center leading-tight">
                      <span>{col.shortLabel}</span>
                      <span className="text-[8px] font-semibold text-slate-400 normal-case">
                        (1 hora)
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="space-y-2">
              {thermalAnalysis.matrixRows.map((row) => (
                <div
                  key={row.dow}
                  className="grid gap-2 items-stretch"
                  style={{
                    gridTemplateColumns:
                      matrixGranularity === "shifts"
                        ? "115px repeat(4, minmax(140px, 1fr))"
                        : "100px repeat(15, minmax(76px, 1fr))",
                  }}
                >
                  <div className="flex flex-col justify-center pr-2">
                    <span className="text-xs font-bold text-slate-800">
                      {row.dayFull.split("-")[0]}
                    </span>
                    <span className="text-[10px] text-slate-400">
                      {row.occurrences}{" "}
                      {row.occurrences === 1
                        ? "data no filtro"
                        : "datas no filtro"}
                    </span>
                  </div>

                  {row.cells.map((cell) => {
                    const styleClass = getCellVisualStyle(cell);
                    const isDarkBg =
                      cell.status === "contract_locked" ||
                      cell.status === "hot";

                    // Se for data presente ou futura, mostramos a contagem real já alugada no período selecionado
                    const showSelectedPeriodCount = isFutureOrPresentRange;

                    if (matrixGranularity === "hourly") {
                      return (
                        <button
                          key={cell.colId}
                          type="button"
                          onClick={() => setSelectedCell(cell)}
                          className={`min-h-[64px] rounded-xl border p-1.5 flex flex-col items-center justify-between transition-all cursor-pointer tabular-nums ${styleClass}`}
                        >
                          {cell.status === "closed" ? (
                            <span className="text-[10px] m-auto">–</span>
                          ) : (
                            <>
                              <div className="text-center leading-tight">
                                <span className="text-[10px] font-extrabold block">
                                  {showSelectedPeriodCount
                                    ? `Alug: ${cell.occupiedHours}`
                                    : `Ocup: ${cell.occupancyPct}%`}
                                </span>
                                <span className="text-[9px] opacity-85 block">
                                  {showSelectedPeriodCount
                                    ? `Liv: ${cell.freeHours}`
                                    : `${cell.occupiedHours}h/${cell.availableHours}h`}
                                </span>
                              </div>

                              <span
                                className={`text-[8px] font-bold px-1 py-0.5 rounded w-full text-center truncate ${
                                  isDarkBg
                                    ? "bg-black/25 text-white"
                                    : cell.hist30dTemperature === "cold"
                                      ? "bg-sky-200/80 text-sky-950"
                                      : "bg-orange-200/80 text-[#9A3C1D]"
                                }`}
                              >
                                30d: {cell.hist30dOccupancyPct}%
                              </span>
                            </>
                          )}
                        </button>
                      );
                    }

                    return (
                      <button
                        key={cell.colId}
                        type="button"
                        onClick={() => setSelectedCell(cell)}
                        className={`min-h-[88px] rounded-xl border p-3 flex flex-col justify-between text-left transition-all cursor-pointer tabular-nums ${styleClass}`}
                      >
                        {cell.status === "closed" ? (
                          <div className="m-auto text-center">
                            <span className="text-[11px] font-medium block">
                              Fechado
                            </span>
                          </div>
                        ) : (
                          <>
                            <div className="flex items-start justify-between w-full gap-1">
                              <div>
                                <span className="text-sm font-black tracking-tight block">
                                  {showSelectedPeriodCount
                                    ? `Alugados: ${cell.occupiedHours}h`
                                    : `Ocupação: ${cell.occupancyPct}%`}
                                </span>
                                <span className="text-[10px] font-semibold opacity-85 block">
                                  {showSelectedPeriodCount
                                    ? `de ${cell.availableHours}h no período`
                                    : `${cell.occupiedHours}h / ${cell.availableHours}h`}
                                </span>
                              </div>
                              {renderTemperatureBadge(
                                cell.hist30dTemperature,
                                cell.hist30dOccupancyPct,
                                isDarkBg,
                              )}
                            </div>

                            <div className="mt-2 pt-1.5 border-t border-current/10 flex flex-wrap items-center justify-between gap-1 text-[10px] font-semibold opacity-95">
                              <span>
                                {cell.contractHours > 0
                                  ? `Fixo: ${cell.contractHours}h • `
                                  : ""}
                                Avulso/Pass:{" "}
                                {cell.packageHours + cell.avulsoHours}h
                              </span>
                              <span className="underline">
                                Livres: {cell.freeHours}h
                              </span>
                            </div>
                          </>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* MODAL DE DETALHAMENTO POR SALA */}
      <Dialog
        open={Boolean(selectedCell)}
        onOpenChange={(open) => !open && setSelectedCell(null)}
      >
        <DialogContent className="sm:max-w-2xl max-h-[88vh] p-0 gap-0 overflow-hidden flex flex-col bg-white border-slate-200 shadow-2xl rounded-2xl">
          {selectedCell && (
            <>
              <DialogHeader className="px-6 py-4 bg-slate-900 text-white shrink-0">
                <div className="flex items-center justify-between pr-6">
                  <div>
                    <DialogTitle className="text-base font-bold text-white flex items-center gap-2 flex-wrap">
                      <span>
                        {selectedCell.dayFull} • {selectedCell.colLabel}
                      </span>
                      <Badge
                        className={`border-0 text-xs font-bold ${
                          selectedCell.hist30dTemperature === "hot"
                            ? "bg-[#BF4B24] text-white"
                            : selectedCell.hist30dTemperature === "warm"
                              ? "bg-amber-400 text-slate-950"
                              : "bg-sky-400 text-slate-950"
                        }`}
                      >
                        {selectedCell.hist30dTemperature === "hot"
                          ? `Horário Quente (30d: ${selectedCell.hist30dOccupancyPct}%)`
                          : selectedCell.hist30dTemperature === "warm"
                            ? `Horário Morno (30d: ${selectedCell.hist30dOccupancyPct}%)`
                            : `Horário Frio — Ideal p/ Promoção (30d: ${selectedCell.hist30dOccupancyPct}%)`}
                      </Badge>
                    </DialogTitle>
                    <DialogDescription className="text-xs text-slate-300 mt-1">
                      Duração da janela:{" "}
                      <strong>
                        {selectedCell.windowDurationHours}h por dia
                      </strong>{" "}
                      ({selectedCell.occurrencesInPeriod}{" "}
                      {selectedCell.occurrencesInPeriod === 1
                        ? "data no período selecionado"
                        : "datas no período selecionado"}
                      ).
                    </DialogDescription>
                  </div>
                </div>
              </DialogHeader>

              <div className="grid grid-cols-3 divide-x divide-slate-200 border-b border-slate-200 bg-slate-50 text-center py-3 text-xs tabular-nums shrink-0">
                <div>
                  <span className="text-[10px] text-slate-500 block">
                    Já Alugados no Período
                  </span>
                  <strong className="text-sm font-bold text-slate-900">
                    {selectedCell.occupiedHours}h de{" "}
                    {selectedCell.availableHours}h ({selectedCell.occupancyPct}
                    %)
                  </strong>
                </div>
                <div>
                  <span className="text-[10px] text-slate-500 block">
                    Histórico Últimos 30 Dias
                  </span>
                  <strong className="text-sm font-bold text-[#BF4B24]">
                    {selectedCell.hist30dOccupancyPct}% ocupado (
                    {selectedCell.hist30dOccupiedHours}h /{" "}
                    {selectedCell.hist30dAvailableHours}h)
                  </strong>
                </div>
                <div>
                  <span className="text-[10px] text-slate-500 block">
                    Livres p/ Alugar no Período
                  </span>
                  <strong className="text-sm font-bold text-emerald-700">
                    {selectedCell.freeHours}h (R${" "}
                    {formatBRL(selectedCell.idleOpportunityBrl)})
                  </strong>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-6 space-y-2.5">
                {selectedCell.roomBreakdowns.map((rb) => (
                  <div
                    key={rb.roomId}
                    className="p-3.5 rounded-xl border border-slate-200 bg-white flex flex-col sm:flex-row sm:items-center justify-between gap-3 tabular-nums"
                  >
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-bold text-slate-900">
                          {rb.roomName}
                        </span>
                        <Badge className="bg-slate-100 text-slate-700 border-0 text-[10px]">
                          {rb.tierLabel}
                        </Badge>
                        <Badge
                          className={`border-0 text-[10px] font-bold ${
                            rb.hist30dTemperature === "hot"
                              ? "bg-orange-100 text-[#9A3C1D]"
                              : rb.hist30dTemperature === "warm"
                                ? "bg-amber-100 text-amber-900"
                                : "bg-sky-100 text-sky-900"
                          }`}
                        >
                          {rb.hist30dTemperature === "hot"
                            ? `30d: ${rb.hist30dOccupancyPct}% (Quente)`
                            : rb.hist30dTemperature === "warm"
                              ? `30d: ${rb.hist30dOccupancyPct}% (Morno)`
                              : `30d: ${rb.hist30dOccupancyPct}% (Frio • Promo)`}
                        </Badge>
                        {rb.isCohostRoom && (
                          <Badge className="bg-emerald-50 text-emerald-800 border border-emerald-200 text-[10px] font-bold">
                            Co-Host: {rb.cohostName}
                          </Badge>
                        )}
                        {rb.contractHours > 0 && (
                          <Badge className="bg-slate-900 text-white border-0 text-[10px]">
                            {rb.contractNote || "Turno Fixo"}
                          </Badge>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-500 mt-1">
                        {rb.clinicName} • R$ {formatBRL(rb.hourlyRate)}/h •
                        Janela de{" "}
                        <strong>{rb.windowDurationHours}h por dia</strong>
                      </p>
                    </div>

                    <div className="text-right text-xs">
                      <span className="font-bold text-slate-900 block">
                        {rb.availableHours === 0
                          ? "Fechada neste horário"
                          : `Alugados: ${rb.occupiedHours}h • Livres: ${rb.freeHours}h`}
                      </span>
                      <span className="text-[10px] text-slate-500">
                        {rb.daysInPeriod === 1
                          ? `Capacidade de ${rb.windowDurationHours}h nesta data`
                          : `${rb.daysInPeriod} datas no período (${rb.availableHours}h totais)`}{" "}
                        • Contr: {rb.contractHours}h • Avulso/Pass:{" "}
                        {rb.packageHours + rb.avulsoHours}h
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
