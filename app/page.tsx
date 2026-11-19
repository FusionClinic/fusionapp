// app/page.tsx
"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { cn } from "@/lib/utils";
import { SearchTab, type Room } from "@/components/search-tab";
import { RoomDetail } from "@/components/room-detail";
import { FusionPassPromoPopup } from "@/components/fusion-pass-promo-popup";
import {
  CampaignRulesModal,
  extractCampaignRulesText,
} from "@/components/campaign-rules-modal";
import {
  Search,
  Heart,
  CalendarDays,
  LogIn,
  Loader2,
  ChevronRight,
  ShieldCheck,
  Clock,
  Building2,
  Tag,
  Percent,
  Flame,
  MapPin,
  Users,
  X,
  FileText,
} from "lucide-react";

const navItems = [
  { id: "buscar" as const, label: "Buscar", icon: Search },
  { id: "pass" as const, label: "Pass+ (-41%)", icon: Tag, isPromo: true },
  { id: "favoritos" as const, label: "Favoritos", icon: Heart },
  { id: "reservas" as const, label: "Reservas", icon: CalendarDays },
  { id: "entrar" as const, label: "Entrar", icon: LogIn },
];

type TabId = (typeof navItems)[number]["id"];

export interface ActiveBlackCampaignInfo {
  id: string;
  campaignName: string;
  code: string;
  discountType: "percentage" | "fixed" | string;
  discountValue: number;
  validUntil: string | null;
  validRoomIds: string[] | null;
  rulesText: string | null;
}

const WEEKDAY_SHORT_NAMES: Record<string, string> = {
  "1": "Seg",
  "2": "Ter",
  "3": "Qua",
  "4": "Qui",
  "5": "Sex",
  "6": "Sáb",
  "0": "Dom",
};

export default function AppPage() {
  const router = useRouter();
  const [supabase] = useState(() => createClient());

  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>("buscar");
  const [selectedRoom, setSelectedRoom] = useState<Room | null>(null);
  const [logoError, setLogoError] = useState(false);

  const [activeBlackCampaign, setActiveBlackCampaign] =
    useState<ActiveBlackCampaignInfo | null>(null);
  const [campaignRooms, setCampaignRooms] = useState<any[]>([]);
  const [showOnlyCampaignRooms, setShowOnlyCampaignRooms] = useState(false);
  const [campaignSearchQuery, setCampaignSearchQuery] = useState("");
  const [campaignSpecialtyFilter, setCampaignSpecialtyFilter] =
    useState("Todas");
  const [isCampaignRulesOpen, setIsCampaignRulesOpen] = useState(false);

  const campaignSectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let isMounted = true;

    async function checkAuth() {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();

        if (!session?.user) {
          if (isMounted) setIsCheckingAuth(false);
          return;
        }

        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError || !user) {
          await supabase.auth.signOut().catch(() => {});
          if (isMounted) setIsCheckingAuth(false);
          return;
        }

        const { data: profile } = await supabase
          .from("profiles")
          .select("role")
          .eq("id", user.id)
          .maybeSingle();

        if (!profile?.role) {
          if (isMounted) setIsCheckingAuth(false);
          return;
        }

        if (profile.role === "host") {
          router.replace("/host");
        } else if (profile.role === "admin") {
          router.replace("/admin/dashboard");
        } else {
          router.replace("/dashboard");
        }
      } catch (error) {
        if (isMounted) setIsCheckingAuth(false);
      }
    }

    checkAuth();

    return () => {
      isMounted = false;
    };
  }, [router, supabase]);

  useEffect(() => {
    let isMounted = true;

    async function fetchCampaignsAndParticipatingRooms() {
      try {
        const [{ data: couponsData }, { data: roomsData }] = await Promise.all([
          supabase
            .from("coupons")
            .select("*")
            .eq("is_active", true)
            .order("created_at", { ascending: false }),
          supabase
            .from("rooms")
            .select("*")
            .eq("is_active", true)
            .order("created_at", { ascending: false }),
        ]);

        if (!isMounted || !couponsData) return;

        const now = new Date();
        const todayIso = now.toISOString().slice(0, 10);

        const validCampaigns = couponsData.filter((c: any) => {
          if (c.valid_until && new Date(c.valid_until) < now) return false;
          if (c.max_uses && Number(c.current_uses || 0) >= Number(c.max_uses)) {
            return false;
          }

          let rules = c.schedule_rules;
          if (typeof rules === "string") {
            try {
              rules = JSON.parse(rules);
            } catch {
              rules = null;
            }
          }

          if (
            rules?.start_date &&
            todayIso < String(rules.start_date).slice(0, 10)
          ) {
            return false;
          }

          const showOnCal =
            typeof c.show_on_calendar === "boolean"
              ? c.show_on_calendar
              : Boolean(rules?.show_on_calendar);

          const isCampaign =
            Boolean(rules?.is_campaign) || Boolean(rules?.enabled) || showOnCal;

          return isCampaign && showOnCal;
        });

        if (validCampaigns.length > 0) {
          const primaryCamp = validCampaigns[0];
          let parsedRules = primaryCamp.schedule_rules;
          if (typeof parsedRules === "string") {
            try {
              parsedRules = JSON.parse(parsedRules);
            } catch {
              parsedRules = null;
            }
          }

          setActiveBlackCampaign({
            id: primaryCamp.id,
            campaignName:
              primaryCamp.campaign_name ||
              parsedRules?.campaign_name ||
              "BLACK FUSION",
            code: primaryCamp.code || "BLACK",
            discountType: primaryCamp.type || "percentage",
            discountValue: Number(primaryCamp.discount_value || 50),
            validUntil: primaryCamp.valid_until || null,
            validRoomIds: Array.isArray(primaryCamp.valid_room_ids)
              ? primaryCamp.valid_room_ids
              : null,
            rulesText: extractCampaignRulesText(primaryCamp),
          });

          const allActiveRooms = (roomsData || []).filter(
            (r: any) => !r.is_paused,
          );

          const matchedRooms = allActiveRooms
            .map((room: any) => {
              const matchingCamp = validCampaigns.find((camp: any) => {
                if (
                  Array.isArray(camp.valid_room_ids) &&
                  camp.valid_room_ids.length > 0
                ) {
                  return camp.valid_room_ids.includes(room.id);
                }
                return true;
              });

              if (!matchingCamp) return null;

              let cRules = matchingCamp.schedule_rules;
              if (typeof cRules === "string") {
                try {
                  cRules = JSON.parse(cRules);
                } catch {
                  cRules = null;
                }
              }

              const dayHoursObj = cRules?.day_hours || {};
              const activeDaysLabels: string[] = [];
              Object.entries(dayHoursObj).forEach(([dKey, hrs]) => {
                if (Array.isArray(hrs) && hrs.length > 0) {
                  const dayLabel = WEEKDAY_SHORT_NAMES[dKey] || "";
                  if (dayLabel) activeDaysLabels.push(dayLabel);
                }
              });

              return {
                ...room,
                campaignInfo: {
                  name:
                    matchingCamp.campaign_name ||
                    cRules?.campaign_name ||
                    matchingCamp.code,
                  type: matchingCamp.type || "percentage",
                  discountValue: Number(matchingCamp.discount_value || 50),
                  daysLabel:
                    activeDaysLabels.length > 0
                      ? activeDaysLabels.join(", ")
                      : "Horários selecionados",
                },
              };
            })
            .filter(Boolean);

          setCampaignRooms(matchedRooms);
        } else {
          setActiveBlackCampaign(null);
          setCampaignRooms([]);
          setShowOnlyCampaignRooms(false);
        }
      } catch {
        if (isMounted) {
          setActiveBlackCampaign(null);
          setCampaignRooms([]);
        }
      }
    }

    fetchCampaignsAndParticipatingRooms();

    return () => {
      isMounted = false;
    };
  }, [supabase]);

  const handleActivateCampaignRoomsSearch = useCallback(() => {
    setSelectedRoom(null);
    setActiveTab("buscar");
    setShowOnlyCampaignRooms(true);
    setTimeout(() => {
      if (campaignSectionRef.current) {
        campaignSectionRef.current.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }
    }, 100);
  }, []);

  useEffect(() => {
    window.addEventListener(
      "open-campaign-rooms-search",
      handleActivateCampaignRoomsSearch,
    );
    return () => {
      window.removeEventListener(
        "open-campaign-rooms-search",
        handleActivateCampaignRoomsSearch,
      );
    };
  }, [handleActivateCampaignRoomsSearch]);

  useEffect(() => {
    if (isCheckingAuth) return;

    if (!window.location.hash || window.location.hash === "") {
      window.history.replaceState(
        null,
        "",
        window.location.pathname + "#buscar",
      );
      setActiveTab("buscar");
    } else {
      const hash = window.location.hash.replace("#", "");
      if (hash === "buscar") {
        setActiveTab("buscar");
      }
    }

    const handlePopState = () => {
      const hash = window.location.hash.replace("#", "");

      if (!hash || hash === "") {
        if (activeTab !== "buscar") {
          window.history.pushState(
            null,
            "",
            window.location.pathname + "#buscar",
          );
          setActiveTab("buscar");
          setSelectedRoom(null);
        }
        return;
      }

      if (hash.startsWith("room/")) {
        return;
      }

      if (hash === "buscar") {
        setSelectedRoom(null);
        setActiveTab("buscar");
      }
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [activeTab, isCheckingAuth]);

  const handleOpenRoom = useCallback((room: Room | any) => {
    setSelectedRoom(room);
    window.history.pushState(
      null,
      "",
      window.location.pathname + "#room/" + room.id,
    );
  }, []);

  const handleCloseRoom = useCallback(() => {
    if (window.location.hash.startsWith("#room/")) {
      window.history.back();
    } else {
      setSelectedRoom(null);
    }
  }, []);

  const handleOpenFusionPassShowcase = useCallback(() => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("open-fusion-pass", { detail: { step: "plans" } }),
      );
    }
  }, []);

  const handleTabClick = (id: TabId) => {
    if (id === "pass") {
      handleOpenFusionPassShowcase();
      return;
    }
    if (id !== "buscar") {
      router.push("/login");
    } else {
      setShowOnlyCampaignRooms(false);
      if (activeTab === "buscar" && !selectedRoom) return;
      setActiveTab("buscar");
      setSelectedRoom(null);
      window.history.pushState(null, "", window.location.pathname + "#buscar");
    }
  };

  const filteredCampaignRooms = useMemo(() => {
    const q = campaignSearchQuery.toLowerCase().trim();
    return campaignRooms.filter((room) => {
      let addr = room.address_details || {};
      if (typeof addr === "string") {
        try {
          addr = JSON.parse(addr);
        } catch {
          addr = {};
        }
      }

      if (campaignSpecialtyFilter !== "Todas") {
        const mainSpec = String(room.specialty || "").toLowerCase();
        const secSpecs = Array.isArray(addr.secondary_specialties)
          ? addr.secondary_specialties.map((s: string) => s.toLowerCase())
          : [];
        const filterLower = campaignSpecialtyFilter.toLowerCase();
        const matchSpec =
          mainSpec.includes(filterLower) ||
          secSpecs.some((s: string) => s.includes(filterLower));
        if (!matchSpec) return false;
      }

      if (!q) return true;
      const matchName = String(room.name || "")
        .toLowerCase()
        .includes(q);
      const matchNeighborhood = String(addr.neighborhood || "")
        .toLowerCase()
        .includes(q);
      const matchCity = String(addr.city || "")
        .toLowerCase()
        .includes(q);
      const matchSpecialty = String(room.specialty || "")
        .toLowerCase()
        .includes(q);

      return matchName || matchNeighborhood || matchCity || matchSpecialty;
    });
  }, [campaignRooms, campaignSearchQuery, campaignSpecialtyFilter]);

  if (isCheckingAuth) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[#FAF7F5]">
        <Loader2 className="w-10 h-10 animate-spin text-[#BF4B24]" />
      </div>
    );
  }

  const isBlackFridayActive = Boolean(activeBlackCampaign);
  const isFullDarkCampaignPage =
    !selectedRoom &&
    activeTab === "buscar" &&
    showOnlyCampaignRooms &&
    isBlackFridayActive;

  const campaignDiscountLabel =
    activeBlackCampaign?.discountType === "fixed"
      ? `R$ ${activeBlackCampaign.discountValue} OFF`
      : `${activeBlackCampaign?.discountValue || 50}% OFF`;

  return (
    <div
      className={cn(
        "flex min-h-svh flex-col font-sans transition-colors duration-300",
        isFullDarkCampaignPage
          ? "bg-[#050507] text-white"
          : "bg-[#FAF7F4] text-stone-900",
      )}
    >
      {/* Modal de Regulamento da Campanha */}
      <CampaignRulesModal
        isOpen={isCampaignRulesOpen}
        onClose={() => setIsCampaignRulesOpen(false)}
        campaignName={activeBlackCampaign?.campaignName}
        rulesText={activeBlackCampaign?.rulesText}
        badgeText={campaignDiscountLabel}
      />

      {/* Ponte de alinhamento exclusiva para o Desktop (lg:) */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
            @media (min-width: 1024px) {
              .fusion-desktop-hero-bridge {
                margin-top: -4.25rem !important;
                position: relative !important;
                z-index: 30 !important;
              }
              .fusion-desktop-hero-bridge > div > div:first-child,
              .fusion-desktop-hero-bridge > div > header:first-child,
              .fusion-desktop-hero-bridge > div:first-child > div:first-child {
                background: transparent !important;
                background-color: transparent !important;
                background-image: none !important;
                padding-top: 0 !important;
                padding-bottom: 1.25rem !important;
                box-shadow: none !important;
                border-radius: 0 !important;
              }
            }
          `,
        }}
      />

      {/* Pop-up Inteligente */}
      <FusionPassPromoPopup />

      {/* 1. TOP PROMO BAR PRETA */}
      {!selectedRoom && (
        <div className="bg-[#0C0A09] text-white px-3.5 lg:px-10 py-2 lg:py-2.5 z-50 border-b border-white/10">
          <div className="max-w-[1360px] mx-auto flex items-center justify-between gap-2.5 lg:gap-4">
            <div className="flex items-center gap-2 lg:gap-3 min-w-0">
              <span className="inline-flex items-center gap-1 lg:gap-1.5 bg-[#EAB308] text-stone-950 text-[9px] lg:text-[10px] font-extrabold uppercase tracking-wider px-2 lg:px-2.5 py-0.5 rounded-full shrink-0 shadow-2xs">
                {isBlackFridayActive ? (
                  <Flame className="w-2.5 h-2.5 lg:w-3 lg:h-3 fill-stone-950 stroke-[2.5]" />
                ) : (
                  <Tag className="w-2.5 h-2.5 lg:w-3 lg:h-3 stroke-[2.5]" />
                )}
                <span className="hidden sm:inline">
                  {isBlackFridayActive
                    ? activeBlackCampaign?.campaignName
                    : "FUSION PASS+"}
                </span>
                <span className="sm:hidden">
                  {isBlackFridayActive ? "BLACK" : "PASS+"}
                </span>
              </span>
              <p className="text-[11px] lg:text-xs font-bold text-[#FBBF24] truncate">
                {isBlackFridayActive ? (
                  <>
                    <span className="sm:hidden">
                      Horários avulsos com {campaignDiscountLabel}
                    </span>
                    <span className="hidden sm:inline">
                      Horários selecionados com {campaignDiscountLabel} nas
                      salas participantes da campanha
                    </span>
                  </>
                ) : (
                  <>
                    <span className="sm:hidden">
                      Horas com até 41% de desconto
                    </span>
                    <span className="hidden sm:inline">
                      Compre suas horas com até 41% de desconto • Sem fidelidade
                      • Use em qualquer unidade
                    </span>
                  </>
                )}
              </p>
            </div>

            <button
              type="button"
              onClick={
                isBlackFridayActive
                  ? handleActivateCampaignRoomsSearch
                  : handleOpenFusionPassShowcase
              }
              className="px-3 lg:px-4 py-1 rounded-full border border-amber-400/80 hover:border-amber-300 hover:bg-amber-400/15 text-[#FBBF24] font-bold text-[11px] lg:text-xs shrink-0 flex items-center gap-0.5 lg:gap-1 transition-all active:scale-95 cursor-pointer"
            >
              <span>
                {isBlackFridayActive ? "Ver Salas em Oferta" : "Ver Planos"}
              </span>
              <ChevronRight className="w-3 h-3 lg:w-3.5 lg:h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* 2. HEADER DESKTOP */}
      {!selectedRoom && (
        <header
          className={cn(
            "hidden lg:block sticky top-0 z-40 border-b transition-colors duration-300",
            isFullDarkCampaignPage
              ? "bg-[#09090B] border-zinc-800"
              : "bg-white border-stone-200/70",
          )}
        >
          <div className="max-w-[1360px] mx-auto px-10 h-20 flex items-center justify-between gap-8">
            <button
              type="button"
              onClick={() => handleTabClick("buscar")}
              className="flex items-center shrink-0 cursor-pointer focus:outline-none"
            >
              {!logoError ? (
                <img
                  src="/logo-fusion-orange.png"
                  alt="Fusion Clinic"
                  onError={() => setLogoError(true)}
                  className={cn(
                    "h-10 w-auto object-contain",
                    isFullDarkCampaignPage ? "brightness-110" : "",
                  )}
                />
              ) : (
                <span
                  className={cn(
                    "text-xl font-black tracking-tight",
                    isFullDarkCampaignPage ? "text-white" : "text-stone-900",
                  )}
                >
                  Fusion<span className="text-[#BF4B24]">.</span>
                </span>
              )}
            </button>

            <nav className="flex items-center gap-9">
              <button
                type="button"
                onClick={() => handleTabClick("buscar")}
                className={cn(
                  "relative py-2.5 text-[15px] font-semibold whitespace-nowrap transition-colors cursor-pointer",
                  activeTab === "buscar" && !showOnlyCampaignRooms
                    ? isFullDarkCampaignPage
                      ? "text-white"
                      : "text-stone-900"
                    : isFullDarkCampaignPage
                      ? "text-zinc-400 hover:text-white"
                      : "text-stone-500 hover:text-stone-900",
                )}
              >
                Explorar Salas
                {activeTab === "buscar" && !showOnlyCampaignRooms && (
                  <span
                    className={cn(
                      "absolute bottom-0 inset-x-0 h-[3px] rounded-full",
                      isBlackFridayActive ? "bg-stone-950" : "bg-[#C84B20]",
                    )}
                  />
                )}
              </button>

              {isBlackFridayActive && (
                <button
                  type="button"
                  onClick={handleActivateCampaignRoomsSearch}
                  className={cn(
                    "relative py-2.5 text-[15px] font-bold whitespace-nowrap flex items-center gap-2 transition-colors cursor-pointer",
                    showOnlyCampaignRooms
                      ? isFullDarkCampaignPage
                        ? "text-[#FBBF24]"
                        : "text-stone-950"
                      : isFullDarkCampaignPage
                        ? "text-zinc-300 hover:text-white"
                        : "text-stone-700 hover:text-stone-950",
                  )}
                >
                  <span>Salas na Black</span>
                  <span className="text-[11px] font-black text-[#FBBF24] bg-stone-950 border border-amber-400/50 px-2.5 py-0.5 rounded-full shadow-2xs flex items-center gap-1">
                    <Flame className="w-3 h-3 fill-[#FBBF24] text-[#FBBF24]" />-
                    {activeBlackCampaign?.discountValue}%
                  </span>
                  {showOnlyCampaignRooms && (
                    <span
                      className={cn(
                        "absolute bottom-0 inset-x-0 h-[3px] rounded-full",
                        isFullDarkCampaignPage
                          ? "bg-[#FBBF24]"
                          : "bg-stone-950",
                      )}
                    />
                  )}
                </button>
              )}

              <button
                type="button"
                onClick={handleOpenFusionPassShowcase}
                className={cn(
                  "py-2.5 text-[15px] font-medium whitespace-nowrap flex items-center gap-2 transition-colors cursor-pointer",
                  isFullDarkCampaignPage
                    ? "text-zinc-300 hover:text-white"
                    : "text-stone-700 hover:text-stone-900",
                )}
              >
                <span>Planos Pass+</span>
                <span className="text-[11px] font-bold text-white bg-gradient-to-r from-[#EA580C] to-[#F59E0B] px-2.5 py-0.5 rounded-full shadow-2xs">
                  Até -41%
                </span>
              </button>

              <button
                type="button"
                onClick={() => handleTabClick("favoritos")}
                className={cn(
                  "py-2.5 text-[15px] font-medium whitespace-nowrap transition-colors cursor-pointer",
                  isFullDarkCampaignPage
                    ? "text-zinc-300 hover:text-white"
                    : "text-stone-700 hover:text-stone-900",
                )}
              >
                Favoritos
              </button>

              <button
                type="button"
                onClick={() => handleTabClick("reservas")}
                className={cn(
                  "py-2.5 text-[15px] font-medium whitespace-nowrap transition-colors cursor-pointer",
                  isFullDarkCampaignPage
                    ? "text-zinc-300 hover:text-white"
                    : "text-stone-700 hover:text-stone-900",
                )}
              >
                Reservas
              </button>
            </nav>

            <div className="flex items-center gap-6 shrink-0">
              <button
                type="button"
                onClick={() => router.push("/login")}
                className={cn(
                  "text-[15px] font-medium whitespace-nowrap transition-colors cursor-pointer",
                  isFullDarkCampaignPage
                    ? "text-zinc-200 hover:text-[#FBBF24]"
                    : "text-stone-800 hover:text-[#BF4B24]",
                )}
              >
                Entrar
              </button>

              <button
                type="button"
                onClick={() => router.push("/login")}
                className={cn(
                  "px-6 py-2.5 rounded-full text-[15px] font-semibold whitespace-nowrap transition-all hover:scale-[1.01] active:scale-[0.99] cursor-pointer",
                  isFullDarkCampaignPage
                    ? "bg-[#FBBF24] hover:bg-amber-400 text-stone-950 font-black"
                    : isBlackFridayActive
                      ? "bg-stone-950 hover:bg-stone-800 text-white shadow-[0_6px_20px_rgba(12,10,9,0.28)]"
                      : "bg-gradient-to-r from-[#C24116] to-[#DE5D2E] hover:from-[#A83812] hover:to-[#C84B20] text-white shadow-[0_6px_20px_rgba(191,75,36,0.3)]",
                )}
              >
                Criar conta
              </button>
            </div>
          </div>
        </header>
      )}

      {/* 3. HERO BANNER DESKTOP */}
      {!selectedRoom && activeTab === "buscar" && !showOnlyCampaignRooms && (
        <section
          className={cn(
            "hidden lg:block relative w-full min-h-[430px] xl:min-h-[460px] overflow-hidden transition-colors duration-500",
            isBlackFridayActive ? "bg-[#09090B]" : "bg-[#B83B10]",
          )}
        >
          <div className="absolute inset-y-0 right-0 w-[65%] z-0">
            <img
              src="/hero.png"
              alt="Consultório Fusion Clinic"
              className="w-full h-full object-cover object-[center_70%] transition-all duration-500"
            />
            <div
              className="absolute inset-0"
              style={{
                background: isBlackFridayActive
                  ? "linear-gradient(90deg, #09090B 0%, #09090B 15%, rgba(9,9,11,0.92) 32%, rgba(9,9,11,0.38) 56%, rgba(9,9,11,0.05) 78%)"
                  : "linear-gradient(90deg, #B83B10 0%, #B83B10 12%, rgba(184,59,16,0.90) 28%, rgba(184,59,16,0.22) 52%, rgba(184,59,16,0) 72%)",
              }}
            />
          </div>

          <div
            className="absolute inset-x-0 bottom-0 h-28 z-10 pointer-events-none"
            style={{
              background: isBlackFridayActive
                ? "linear-gradient(180deg, rgba(9,9,11,0) 0%, rgba(250,247,244,0.72) 68%, #FAF7F4 100%)"
                : "linear-gradient(180deg, rgba(184,59,16,0) 0%, rgba(250,247,244,0.65) 65%, #FAF7F4 100%)",
            }}
          />

          <div className="relative z-20 max-w-[1360px] mx-auto px-10 pt-16 pb-32 flex items-end justify-between gap-8">
            <div className="max-w-[610px] space-y-4 text-white">
              {isBlackFridayActive && (
                <div className="flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    onClick={handleActivateCampaignRoomsSearch}
                    className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-amber-400/15 hover:bg-amber-400/25 border border-amber-400/40 backdrop-blur-xs transition-colors cursor-pointer"
                  >
                    <Flame className="w-3.5 h-3.5 text-[#FBBF24] fill-[#FBBF24]" />
                    <span className="text-[11px] font-black uppercase tracking-widest text-[#FBBF24]">
                      {activeBlackCampaign?.campaignName} • Horários das Salas
                      em Oferta
                    </span>
                  </button>

                  {activeBlackCampaign?.rulesText && (
                    <button
                      type="button"
                      onClick={() => setIsCampaignRulesOpen(true)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/10 hover:bg-white/20 border border-white/15 text-[11px] font-bold text-stone-200 hover:text-white transition-colors cursor-pointer"
                    >
                      <FileText className="w-3.5 h-3.5 text-[#FBBF24]" />
                      <span>Ver regulamento</span>
                    </button>
                  )}
                </div>
              )}

              <h1 className="text-[44px] xl:text-[52px] font-extrabold tracking-tight text-white leading-[1.1]">
                Consultórios prontos,{" "}
                <span
                  className={cn(
                    "font-serif italic font-normal",
                    isBlackFridayActive ? "text-[#FBBF24]" : "text-white",
                  )}
                >
                  esperando por você.
                </span>
              </h1>

              <p className="text-[15px] xl:text-base text-white/95 font-normal leading-relaxed max-w-[510px]">
                Encontre o espaço ideal para atender seus pacientes. Reserve por
                hora, turno ou pacote, sem precisar manter um consultório
                próprio.
              </p>
            </div>

            <div className="shrink-0">
              {isBlackFridayActive ? (
                <button
                  type="button"
                  onClick={handleActivateCampaignRoomsSearch}
                  className="group relative w-[235px] rounded-[22px] bg-stone-950/95 hover:bg-stone-900 backdrop-blur-md border border-amber-400/40 p-4 text-left shadow-[0_18px_40px_rgba(0,0,0,0.45)] transition-all duration-300 hover:-translate-y-1 cursor-pointer"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="inline-flex items-center gap-1 text-[10px] font-extrabold uppercase tracking-wider text-[#FBBF24]">
                      <Flame className="w-3 h-3 fill-[#FBBF24] text-[#FBBF24]" />
                      {activeBlackCampaign?.campaignName || "BLACK FUSION"}
                    </span>
                    <span className="w-6 h-6 rounded-full bg-amber-400/15 text-[#FBBF24] flex items-center justify-center">
                      <Percent className="w-3 h-3 stroke-[2.5]" />
                    </span>
                  </div>

                  <div className="flex items-baseline gap-1.5">
                    <span className="text-2xl font-black tracking-tight text-white leading-none">
                      {campaignDiscountLabel}
                    </span>
                  </div>
                  <p className="text-[11px] font-medium text-stone-400 mt-0.5">
                    nos horários das salas em campanha
                  </p>

                  <div className="mt-2.5 px-2.5 py-1.5 rounded-xl bg-white/5 border border-white/10 flex items-center justify-between text-[11px]">
                    <span className="text-stone-300 font-medium">
                      {campaignRooms.length}{" "}
                      {campaignRooms.length === 1
                        ? "sala participante"
                        : "salas participantes"}
                    </span>
                  </div>

                  <span className="mt-2.5 inline-flex items-center gap-1 text-xs font-bold text-[#FBBF24] group-hover:translate-x-0.5 transition-transform">
                    <span>Ver salas da campanha</span>
                    <ChevronRight className="w-3.5 h-3.5 stroke-[2.5]" />
                  </span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleOpenFusionPassShowcase}
                  className="group relative w-[215px] rounded-[22px] bg-[#FAF7F4]/92 hover:bg-white backdrop-blur-md border border-white/85 p-4 text-left shadow-[0_14px_34px_rgba(28,25,23,0.14)] transition-all duration-300 hover:-translate-y-1 cursor-pointer"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="inline-flex items-center gap-1 text-[10px] font-extrabold uppercase tracking-wider text-[#BF4B24]">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#BF4B24] animate-pulse" />
                      Fusion Pass+
                    </span>
                    <span className="w-6 h-6 rounded-full bg-[#BF4B24]/12 text-[#BF4B24] flex items-center justify-center">
                      <Percent className="w-3 h-3 stroke-[2.5]" />
                    </span>
                  </div>

                  <div className="flex items-baseline gap-1.5">
                    <span className="text-2xl font-black tracking-tight text-stone-900 leading-none">
                      Até 41%
                    </span>
                    <span className="text-xs font-extrabold uppercase text-[#BF4B24]">
                      OFF
                    </span>
                  </div>
                  <p className="text-[11px] font-medium text-stone-500 mt-0.5">
                    no valor da hora clínica
                  </p>

                  <div className="mt-2.5 px-2.5 py-1.5 rounded-xl bg-white border border-stone-200/80 flex items-center justify-between text-[11px]">
                    <span className="text-stone-400 line-through">R$ 45/h</span>
                    <span className="font-bold text-stone-800">
                      por <strong className="text-[#BF4B24]">R$ 26/h</strong>
                    </span>
                  </div>

                  <span className="mt-2.5 inline-flex items-center gap-1 text-xs font-bold text-[#BF4B24] group-hover:translate-x-0.5 transition-transform">
                    <span>Simular desconto</span>
                    <ChevronRight className="w-3.5 h-3.5 stroke-[2.5]" />
                  </span>
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      {/* 4. CONTEÚDO PRINCIPAL */}
      <main
        className={cn(
          "flex-1 w-full",
          selectedRoom
            ? ""
            : isFullDarkCampaignPage
              ? "bg-[#050507] pb-12 lg:pb-20"
              : "pb-6 lg:pb-16",
        )}
      >
        {selectedRoom ? (
          <RoomDetail
            roomId={selectedRoom.id}
            room={selectedRoom}
            onBack={handleCloseRoom}
            onNavigateToChat={() => router.push("/login")}
            initialModality={selectedRoom.selectedModality || "hora"}
          />
        ) : (
          <>
            {activeTab === "buscar" && (
              <div ref={campaignSectionRef}>
                {showOnlyCampaignRooms && isBlackFridayActive ? (
                  <div className="w-full min-h-[80vh] bg-[#050507] text-white">
                    <div className="max-w-[1360px] mx-auto px-4 sm:px-6 lg:px-10 pt-5 sm:pt-8 pb-12 animate-in fade-in duration-300">
                      <div className="bg-[#0D0D11] text-white rounded-3xl p-5 sm:p-7 border border-amber-400/35 shadow-[0_20px_50px_rgba(0,0,0,0.85)] mb-7">
                        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-zinc-800/90">
                          <div className="space-y-2">
                            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-400/15 border border-amber-400/40 text-[#FBBF24] text-[10px] font-black uppercase tracking-wider">
                              <Flame className="w-3.5 h-3.5 fill-[#FBBF24]" />
                              {activeBlackCampaign?.campaignName} • Horários em
                              Oferta
                            </div>
                            <h2 className="text-xl sm:text-3xl font-black text-white tracking-tight leading-tight">
                              Salas participantes com{" "}
                              <span className="text-[#FBBF24]">
                                {campaignDiscountLabel}
                              </span>{" "}
                              nos horários selecionados
                            </h2>
                            <p className="text-xs sm:text-sm text-zinc-400">
                              Escolha uma das salas abaixo e toque nos dias em
                              preto no calendário para reservar seu horário com
                              desconto.
                            </p>
                          </div>

                          <div className="flex flex-wrap items-center gap-2.5 self-start lg:self-center shrink-0">
                            {activeBlackCampaign?.rulesText && (
                              <button
                                type="button"
                                onClick={() => setIsCampaignRulesOpen(true)}
                                className="px-4 py-2.5 rounded-xl bg-amber-400/15 hover:bg-amber-400/25 border border-amber-400/40 text-[#FBBF24] text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer"
                              >
                                <FileText className="w-4 h-4" />
                                Ver regulamento
                              </button>
                            )}

                            <button
                              type="button"
                              onClick={() => setShowOnlyCampaignRooms(false)}
                              className="px-4 py-2.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer"
                            >
                              <X className="w-4 h-4 text-[#FBBF24]" />
                              Ver todas as salas da plataforma
                            </button>
                          </div>
                        </div>

                        <div className="mt-5 flex flex-col md:flex-row items-stretch md:items-center gap-3">
                          <div className="relative flex-1">
                            <Search className="w-4 h-4 text-[#FBBF24] absolute left-3.5 top-1/2 -translate-y-1/2" />
                            <input
                              type="text"
                              value={campaignSearchQuery}
                              onChange={(e) =>
                                setCampaignSearchQuery(e.target.value)
                              }
                              placeholder="Pesquisar sala participante por nome, bairro ou especialidade..."
                              className="w-full h-11 pl-10 pr-4 rounded-xl bg-[#16161C] border border-zinc-800 focus:border-[#FBBF24] text-white placeholder:text-zinc-500 text-xs sm:text-sm font-semibold outline-none transition-colors"
                            />
                          </div>

                          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1 md:pb-0">
                            {[
                              "Todas",
                              "Psicologia",
                              "Nutrição",
                              "Odontologia",
                              "Estética",
                              "Multiuso",
                            ].map((spec) => (
                              <button
                                key={spec}
                                type="button"
                                onClick={() => setCampaignSpecialtyFilter(spec)}
                                className={`px-3.5 py-2.5 rounded-xl text-xs font-bold whitespace-nowrap border transition-all cursor-pointer ${
                                  campaignSpecialtyFilter === spec
                                    ? "bg-[#FBBF24] text-stone-950 border-[#FBBF24] shadow-[0_0_15px_rgba(251,191,36,0.3)]"
                                    : "bg-[#16161C] text-zinc-300 border-zinc-800 hover:border-zinc-700 hover:text-white"
                                }`}
                              >
                                {spec}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>

                      {filteredCampaignRooms.length === 0 ? (
                        <div className="bg-[#0D0D11] rounded-3xl border border-zinc-800 p-12 text-center space-y-3">
                          <p className="text-base font-bold text-white">
                            Nenhuma sala participante encontrada para esta
                            busca.
                          </p>
                          <button
                            type="button"
                            onClick={() => {
                              setCampaignSearchQuery("");
                              setCampaignSpecialtyFilter("Todas");
                            }}
                            className="px-4 py-2 rounded-xl bg-[#FBBF24] text-stone-950 text-xs font-black cursor-pointer"
                          >
                            Limpar filtros da campanha
                          </button>
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                          {filteredCampaignRooms.map((room: any) => {
                            let addr = room.address_details || {};
                            if (typeof addr === "string") {
                              try {
                                addr = JSON.parse(addr);
                              } catch {
                                addr = {};
                              }
                            }
                            const baseHourly = Number(
                              addr?.pricing?.hourly || 45,
                            );
                            const cInfo = room.campaignInfo;
                            const finalHourly =
                              cInfo?.type === "percentage"
                                ? Math.max(
                                    0,
                                    baseHourly *
                                      (1 - cInfo.discountValue / 100),
                                  )
                                : Math.max(0, baseHourly - cInfo.discountValue);

                            const badgeLabel =
                              cInfo?.type === "percentage"
                                ? `-${cInfo.discountValue}% OFF`
                                : `-R$ ${cInfo?.discountValue} OFF`;

                            return (
                              <div
                                key={room.id}
                                onClick={() => handleOpenRoom(room)}
                                className="group bg-[#0F0F14] rounded-3xl border-2 border-zinc-800/90 hover:border-[#FBBF24] overflow-hidden shadow-[0_14px_35px_rgba(0,0,0,0.8)] hover:shadow-[0_14px_40px_rgba(251,191,36,0.15)] transition-all duration-300 flex flex-col cursor-pointer"
                              >
                                <div className="relative h-52 w-full bg-zinc-900 overflow-hidden">
                                  <img
                                    src={room.image_url || "/placeholder.jpg"}
                                    alt={room.name}
                                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                                  />
                                  <div
                                    className="absolute inset-x-0 bottom-0 h-16 pointer-events-none"
                                    style={{
                                      background:
                                        "linear-gradient(180deg, rgba(15,15,20,0) 0%, #0F0F14 100%)",
                                    }}
                                  />
                                  <div className="absolute top-3 left-3 bg-[#050507]/95 text-[#FBBF24] border border-amber-400/60 px-3 py-1 rounded-full text-[11px] font-black uppercase tracking-wider flex items-center gap-1 shadow-lg">
                                    <Flame className="w-3.5 h-3.5 fill-[#FBBF24]" />
                                    {badgeLabel}
                                  </div>
                                </div>

                                <div className="p-5 flex-1 flex flex-col justify-between space-y-4">
                                  <div>
                                    <div className="flex items-center justify-between gap-2 text-xs text-zinc-400 mb-1.5">
                                      <span className="font-semibold flex items-center gap-1 truncate">
                                        <MapPin className="w-3.5 h-3.5 text-[#FBBF24] shrink-0" />
                                        {addr.neighborhood ||
                                          addr.city ||
                                          "Natal"}
                                      </span>
                                      <span className="flex items-center gap-1 shrink-0">
                                        <Users className="w-3.5 h-3.5 text-zinc-500" />
                                        Até {addr.capacity || 4}
                                      </span>
                                    </div>

                                    <h3 className="text-lg font-black text-white group-hover:text-[#FBBF24] transition-colors line-clamp-1">
                                      {room.name}
                                    </h3>

                                    <div className="mt-2.5 px-3 py-2 rounded-xl bg-[#181820] border border-zinc-800 text-zinc-200 text-[11px] font-semibold flex items-center gap-1.5">
                                      <Clock className="w-3.5 h-3.5 text-[#FBBF24] shrink-0" />
                                      <span className="truncate">
                                        Dias em oferta: {cInfo?.daysLabel}
                                      </span>
                                    </div>
                                  </div>

                                  <div className="pt-3.5 border-t border-zinc-800/90 flex items-center justify-between">
                                    <div>
                                      <span className="text-[11px] text-zinc-500 line-through block">
                                        De R${" "}
                                        {baseHourly
                                          .toFixed(2)
                                          .replace(".", ",")}
                                        /h
                                      </span>
                                      <span className="text-xl font-black text-[#FBBF24]">
                                        R${" "}
                                        {finalHourly
                                          .toFixed(2)
                                          .replace(".", ",")}
                                        <span className="text-xs font-semibold text-zinc-400">
                                          /hora
                                        </span>
                                      </span>
                                    </div>

                                    <span className="px-4 py-2.5 rounded-xl bg-[#FBBF24] group-hover:bg-amber-400 text-stone-950 text-xs font-black flex items-center gap-1 transition-colors shadow-sm">
                                      Reservar
                                      <ChevronRight className="w-3.5 h-3.5 stroke-[2.8]" />
                                    </span>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="w-full fusion-desktop-hero-bridge">
                    {isBlackFridayActive && campaignRooms.length > 0 && (
                      <div className="lg:hidden px-4 pt-3 pb-2 bg-[#09090B] space-y-2">
                        <button
                          type="button"
                          onClick={handleActivateCampaignRoomsSearch}
                          className="w-full p-3.5 rounded-2xl bg-[#141418] text-white border border-amber-400/40 flex items-center justify-between gap-2 shadow-lg active:scale-[0.99] transition-transform"
                        >
                          <div className="flex items-center gap-2.5 text-left">
                            <Flame className="w-4 h-4 text-[#FBBF24] fill-[#FBBF24] shrink-0" />
                            <div>
                              <span className="text-xs font-black text-[#FBBF24] block">
                                {activeBlackCampaign?.campaignName} (
                                {campaignDiscountLabel})
                              </span>
                              <span className="text-[11px] text-zinc-300">
                                Toque para filtrar as {campaignRooms.length}{" "}
                                salas participantes
                              </span>
                            </div>
                          </div>
                          <ChevronRight className="w-4 h-4 text-[#FBBF24] shrink-0" />
                        </button>
                      </div>
                    )}
                    <SearchTab onOpenRoom={handleOpenRoom} />
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </main>

      {/* 5. RODAPÉ INSTITUCIONAL */}
      {!selectedRoom && (
        <footer
          className={cn(
            "border-t pb-24 lg:pb-0 transition-colors duration-300",
            isFullDarkCampaignPage
              ? "bg-[#09090B] border-zinc-800 text-zinc-400"
              : "bg-white border-stone-200/80 text-stone-400",
          )}
        >
          <div className="max-w-[1360px] mx-auto px-5 lg:px-10 py-8 lg:py-10">
            <div
              className={cn(
                "hidden lg:grid grid-cols-4 gap-8 pb-8 border-b",
                isFullDarkCampaignPage ? "border-zinc-800" : "border-stone-100",
              )}
            >
              <div className="space-y-1.5">
                <div
                  className={cn(
                    "flex items-center gap-2 font-bold text-sm",
                    isFullDarkCampaignPage ? "text-white" : "text-stone-900",
                  )}
                >
                  <Clock className="w-4 h-4 text-[#BF4B24]" />
                  <span>Reserva Instantânea</span>
                </div>
                <p className="text-xs leading-relaxed">
                  Agenda em tempo real com liberação automática de senha na
                  fechadura digital.
                </p>
              </div>

              <div className="space-y-1.5">
                <div
                  className={cn(
                    "flex items-center gap-2 font-bold text-sm",
                    isFullDarkCampaignPage ? "text-white" : "text-stone-900",
                  )}
                >
                  <Tag className="w-4 h-4 text-[#BF4B24]" />
                  <span>Economia com Fusion Pass+</span>
                </div>
                <p className="text-xs leading-relaxed">
                  Reduza seu custo por hora em até 41%, sem fidelidade e com 30
                  dias para usar.
                </p>
              </div>

              <div className="space-y-1.5">
                <div
                  className={cn(
                    "flex items-center gap-2 font-bold text-sm",
                    isFullDarkCampaignPage ? "text-white" : "text-stone-900",
                  )}
                >
                  <Building2 className="w-4 h-4 text-[#BF4B24]" />
                  <span>Pronto para Atender</span>
                </div>
                <p className="text-xs leading-relaxed">
                  Recepção, Wi-Fi de alta velocidade, climatização, limpeza e
                  café inclusos.
                </p>
              </div>

              <div className="space-y-1.5">
                <div
                  className={cn(
                    "flex items-center gap-2 font-bold text-sm",
                    isFullDarkCampaignPage ? "text-white" : "text-stone-900",
                  )}
                >
                  <ShieldCheck className="w-4 h-4 text-[#BF4B24]" />
                  <span>Sem Custos Fixos</span>
                </div>
                <p className="text-xs leading-relaxed">
                  Reserve apenas pelas horas ou turnos que precisar, sem fiador
                  ou burocracia.
                </p>
              </div>
            </div>

            <div className="lg:pt-6 flex flex-col lg:flex-row items-center justify-between gap-4 text-xs">
              <div className="text-center lg:text-left space-y-0.5">
                <p>
                  © {new Date().getFullYear()} Fusion Clinic Soluções em Saúde
                  Ltda • CNPJ: 49.351.127/0001-44. Todos os direitos reservados.
                </p>
              </div>

              <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 font-medium">
                <Link
                  href="/termos"
                  className="hover:text-[#BF4B24] transition-colors"
                >
                  Termos de Uso
                </Link>
                <Link
                  href="/privacidade"
                  className="hover:text-[#BF4B24] transition-colors"
                >
                  Política de Privacidade
                </Link>
                <Link
                  href="/cookies"
                  className="hover:text-[#BF4B24] transition-colors"
                >
                  Política de Cookies
                </Link>

                <span className="hidden sm:inline opacity-40">•</span>

                <button
                  type="button"
                  onClick={handleOpenFusionPassShowcase}
                  className="hover:text-[#FBBF24] cursor-pointer"
                >
                  Planos Pass+
                </button>
                <button
                  type="button"
                  onClick={() => router.push("/login")}
                  className="hover:text-[#FBBF24] cursor-pointer"
                >
                  Entrar
                </button>
                <button
                  type="button"
                  onClick={() => router.push("/login")}
                  className="hover:text-[#FBBF24] cursor-pointer"
                >
                  Criar conta
                </button>
              </div>
            </div>
          </div>
        </footer>
      )}

      {/* 6. BARRA INFERIOR MOBILE */}
      {!selectedRoom && (
        <nav
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 flex lg:hidden items-stretch justify-around border-t backdrop-blur-md pb-[env(safe-area-inset-bottom)] transition-colors duration-300",
            isFullDarkCampaignPage
              ? "bg-[#09090B]/95 border-zinc-800 shadow-[0_-6px_25px_rgba(0,0,0,0.6)]"
              : "bg-white/95 border-stone-200/90 shadow-[0_-6px_25px_rgba(28,25,23,0.06)]",
          )}
        >
          <div className="flex justify-between items-stretch w-full max-w-md mx-auto px-1">
            {navItems.map((item) => {
              const isActive = activeTab === item.id;
              const isPromo = Boolean((item as any).isPromo);
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleTabClick(item.id)}
                  className={cn(
                    "relative flex flex-1 flex-col items-center justify-center gap-1 py-2.5 transition-colors cursor-pointer active:scale-95",
                    isActive
                      ? isFullDarkCampaignPage
                        ? "text-[#FBBF24]"
                        : "text-[#BF4B24]"
                      : isPromo
                        ? "text-[#BF4B24]/90 hover:text-[#BF4B24]"
                        : isFullDarkCampaignPage
                          ? "text-zinc-500 hover:text-zinc-200"
                          : "text-stone-400 hover:text-stone-700",
                  )}
                >
                  {isActive && (
                    <span
                      className={cn(
                        "absolute top-0 w-6 h-[2.5px] rounded-full",
                        isFullDarkCampaignPage
                          ? "bg-[#FBBF24]"
                          : "bg-[#BF4B24]",
                      )}
                    />
                  )}

                  <item.icon
                    className={cn(
                      "h-5 w-5 transition-transform",
                      isActive
                        ? "stroke-[2.4px] scale-105"
                        : isPromo
                          ? "stroke-[2.2px]"
                          : "stroke-[1.9px]",
                    )}
                  />

                  <span
                    className={cn(
                      "text-[10px] leading-none tracking-tight truncate max-w-[68px]",
                      isActive
                        ? isFullDarkCampaignPage
                          ? "font-bold text-[#FBBF24]"
                          : "font-bold text-[#BF4B24]"
                        : isPromo
                          ? "font-bold text-[#BF4B24]"
                          : isFullDarkCampaignPage
                            ? "font-medium text-zinc-400"
                            : "font-medium text-stone-500",
                    )}
                  >
                    {item.label}
                  </span>
                </button>
              );
            })}
          </div>
        </nav>
      )}
    </div>
  );
}
