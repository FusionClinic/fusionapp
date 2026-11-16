// components/admin/admin-notifications-bell.tsx
"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { createClient } from "@/utils/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Bell,
  CalendarCheck,
  CalendarX,
  UserPlus,
  Building2,
  DoorOpen,
  CheckCheck,
  Trash2,
  Volume2,
  VolumeX,
  Sparkles,
  QrCode,
  CheckCircle2,
  Loader2,
  ChevronRight,
  User,
  Mail,
  Phone,
  FileText,
  Clock,
  ExternalLink,
} from "lucide-react";
import { formatDistanceToNow, parseISO, format } from "date-fns";
import { ptBR } from "date-fns/locale";

export type AdminNotificationEventType =
  | "booking_created"
  | "booking_cancelled"
  | "specialist_registered"
  | "host_registered"
  | "room_created"
  | "booking_checkin"
  | "booking_checkout";

export interface AdminNotificationItem {
  id: string;
  event_type: AdminNotificationEventType | string;
  title: string;
  message: string;
  metadata: {
    booking_id?: string;
    user_id?: string;
    room_id?: string;
    user_name?: string;
    user_email?: string;
    user_phone?: string;
    user_cpf?: string;
    user_specialty?: string;
    room_name?: string;
    host_name?: string;
    date?: string;
    first_hour?: string;
    slots_count?: number;
    amount_brl?: number;
    status?: string;
    target_tab?: string;
    [key: string]: any;
  };
  is_read: boolean;
  read_at: string | null;
  created_at: string;
}

type FilterCategory =
  "all" | "unread" | "bookings" | "cancellations" | "users" | "rooms";

const LOCAL_READ_KEY = "fusion_admin_notif_read_ids_v1";
const LOCAL_CLEARED_KEY = "fusion_admin_notif_cleared_ids_v1";

function getLocalIdSet(key: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

function addLocalIds(key: string, ids: string[]) {
  if (typeof window === "undefined" || ids.length === 0) return;
  try {
    const current = getLocalIdSet(key);
    ids.forEach((id) => current.add(String(id)));
    localStorage.setItem(key, JSON.stringify(Array.from(current).slice(-600)));
  } catch {}
}

interface AdminNotificationsBellProps {
  onNavigateTab?: (tabName: string, metadata?: Record<string, any>) => void;
}

export function AdminNotificationsBell({
  onNavigateTab,
}: AdminNotificationsBellProps) {
  const [supabase] = useState(() => createClient());
  const { toast } = useToast();

  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notifications, setNotifications] = useState<AdminNotificationItem[]>(
    [],
  );
  const [activeFilter, setActiveFilter] = useState<FilterCategory>("all");
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [hasNewPulse, setHasNewPulse] = useState(false);
  const [selectedDetailItem, setSelectedDetailItem] =
    useState<AdminNotificationItem | null>(null);

  const soundEnabledRef = useRef(soundEnabled);
  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
  }, [soundEnabled]);

  const playNotificationChime = useCallback(() => {
    if (!soundEnabledRef.current || typeof window === "undefined") return;
    try {
      const AudioCtx =
        window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;

      const ctx = new AudioCtx();
      const now = ctx.currentTime;

      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = "sine";
      osc2.type = "triangle";

      osc1.frequency.setValueAtTime(880, now);
      osc1.frequency.exponentialRampToValueAtTime(1318.5, now + 0.14);

      osc2.frequency.setValueAtTime(440, now);
      osc2.frequency.exponentialRampToValueAtTime(659.25, now + 0.14);

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.12, now + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.38);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + 0.4);
      osc2.stop(now + 0.4);
    } catch {}
  }, []);

  const fetchNotifications = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      const res = await fetch(`/api/admin/notifications?_t=${Date.now()}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Falha ao buscar notificações");
      const json = await res.json();
      const rawList: AdminNotificationItem[] = Array.isArray(json.notifications)
        ? json.notifications
        : [];

      const localRead = getLocalIdSet(LOCAL_READ_KEY);
      const localCleared = getLocalIdSet(LOCAL_CLEARED_KEY);

      const processed = rawList
        .filter((item) => !localCleared.has(String(item.id)))
        .map((item) => ({
          ...item,
          is_read: Boolean(item.is_read) || localRead.has(String(item.id)),
        }));

      setNotifications(processed);
    } catch (err) {
      console.error("Erro ao carregar notificações do admin:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchNotifications(true);

    const channel = supabase
      .channel("admin-unified-radar-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "admin_notifications" },
        () => {
          fetchNotifications(false);
          setHasNewPulse(true);
          setTimeout(() => setHasNewPulse(false), 4000);
          playNotificationChime();
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "bookings" },
        () => {
          fetchNotifications(false);
          setHasNewPulse(true);
          setTimeout(() => setHasNewPulse(false), 4000);
          playNotificationChime();
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "profiles" },
        () => {
          fetchNotifications(false);
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "rooms" },
        () => {
          fetchNotifications(false);
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, fetchNotifications, playNotificationChime]);

  // Recarrega sempre que o admin abrir a gaveta do sino
  useEffect(() => {
    if (isOpen) {
      fetchNotifications(false);
    }
  }, [isOpen, fetchNotifications]);

  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.is_read).length,
    [notifications],
  );

  const countsByCategory = useMemo(() => {
    return {
      all: notifications.length,
      unread: notifications.filter((n) => !n.is_read).length,
      bookings: notifications.filter((n) =>
        ["booking_created", "booking_checkin", "booking_checkout"].includes(
          n.event_type,
        ),
      ).length,
      cancellations: notifications.filter(
        (n) => n.event_type === "booking_cancelled",
      ).length,
      users: notifications.filter((n) =>
        ["specialist_registered", "host_registered"].includes(n.event_type),
      ).length,
      rooms: notifications.filter((n) => n.event_type === "room_created")
        .length,
    };
  }, [notifications]);

  const filteredNotifications = useMemo(() => {
    return notifications.filter((n) => {
      if (activeFilter === "unread") return !n.is_read;
      if (activeFilter === "bookings")
        return [
          "booking_created",
          "booking_checkin",
          "booking_checkout",
        ].includes(n.event_type);
      if (activeFilter === "cancellations")
        return n.event_type === "booking_cancelled";
      if (activeFilter === "users")
        return ["specialist_registered", "host_registered"].includes(
          n.event_type,
        );
      if (activeFilter === "rooms") return n.event_type === "room_created";
      return true;
    });
  }, [notifications, activeFilter]);

  const handleMarkAsRead = async (id: string) => {
    const nowIso = new Date().toISOString();
    addLocalIds(LOCAL_READ_KEY, [id]);
    setNotifications((prev) =>
      prev.map((n) =>
        n.id === id ? { ...n, is_read: true, read_at: nowIso } : n,
      ),
    );
    try {
      await fetch("/api/admin/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark_read", ids: [id] }),
      });
    } catch {}
  };

  const handleMarkAllAsRead = async () => {
    const unreadIds = notifications.filter((n) => !n.is_read).map((n) => n.id);
    if (unreadIds.length === 0) return;

    const nowIso = new Date().toISOString();
    addLocalIds(LOCAL_READ_KEY, unreadIds);
    setNotifications((prev) =>
      prev.map((n) => ({ ...n, is_read: true, read_at: nowIso })),
    );

    try {
      await fetch("/api/admin/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark_read", ids: unreadIds }),
      });
      toast({
        title: "Tudo em dia!",
        description: `${unreadIds.length} notificações foram marcadas como lidas.`,
      });
    } catch {
      toast({
        variant: "destructive",
        title: "Erro ao sincronizar no servidor",
      });
    }
  };

  const handleDeleteOne = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    addLocalIds(LOCAL_CLEARED_KEY, [id]);
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    try {
      await fetch("/api/admin/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete_one", ids: [id] }),
      });
    } catch {}
  };

  const handleClearRead = async () => {
    const readIds = notifications.filter((n) => n.is_read).map((n) => n.id);
    const targetIds =
      readIds.length > 0 ? readIds : notifications.map((n) => n.id);

    if (targetIds.length === 0) return;

    addLocalIds(LOCAL_CLEARED_KEY, targetIds);
    if (readIds.length > 0) {
      setNotifications((prev) => prev.filter((n) => !n.is_read));
    } else {
      setNotifications([]);
    }

    try {
      await fetch("/api/admin/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: readIds.length > 0 ? "clear_read" : "clear_all",
          ids: targetIds,
        }),
      });
      toast({
        title: "Notificações removidas",
        description: `${targetIds.length} registro(s) limpo(s) do painel.`,
      });
    } catch {
      toast({
        variant: "destructive",
        title: "Erro ao limpar histórico",
      });
    }
  };

  const handleNotificationClick = async (item: AdminNotificationItem) => {
    if (!item.is_read) {
      handleMarkAsRead(item.id);
    }
    setSelectedDetailItem(item);
  };

  const getEventVisuals = (eventType: string) => {
    switch (eventType) {
      case "booking_created":
        return {
          icon: CalendarCheck,
          bgIcon: "bg-emerald-50 text-emerald-600 border-emerald-200",
          badgeText: "Nova Reserva",
          badgeClass: "bg-emerald-50 text-emerald-700",
        };
      case "booking_cancelled":
        return {
          icon: CalendarX,
          bgIcon: "bg-red-50 text-red-600 border-red-200",
          badgeText: "Cancelamento",
          badgeClass: "bg-red-50 text-red-700",
        };
      case "specialist_registered":
        return {
          icon: UserPlus,
          bgIcon: "bg-blue-50 text-blue-600 border-blue-200",
          badgeText: "Novo Especialista",
          badgeClass: "bg-blue-50 text-blue-700",
        };
      case "host_registered":
        return {
          icon: Building2,
          bgIcon: "bg-purple-50 text-purple-600 border-purple-200",
          badgeText: "Novo Anfitrião",
          badgeClass: "bg-purple-50 text-purple-700",
        };
      case "room_created":
        return {
          icon: DoorOpen,
          bgIcon: "bg-orange-50 text-[#BF4B24] border-orange-200",
          badgeText: "Nova Sala",
          badgeClass: "bg-orange-50 text-[#BF4B24]",
        };
      case "booking_checkin":
        return {
          icon: QrCode,
          bgIcon: "bg-amber-50 text-amber-700 border-amber-200",
          badgeText: "Check-in Porta",
          badgeClass: "bg-amber-50 text-amber-800",
        };
      case "booking_checkout":
        return {
          icon: CheckCircle2,
          bgIcon: "bg-teal-50 text-teal-700 border-teal-200",
          badgeText: "Check-out",
          badgeClass: "bg-teal-50 text-teal-800",
        };
      default:
        return {
          icon: Sparkles,
          bgIcon: "bg-slate-100 text-slate-600 border-slate-200",
          badgeText: "Sistema",
          badgeClass: "bg-slate-100 text-slate-700",
        };
    }
  };

  return (
    <>
      <Sheet open={isOpen} onOpenChange={setIsOpen}>
        <SheetTrigger asChild>
          <button
            type="button"
            title="Radar da Plataforma — Notificações"
            className={`relative inline-flex items-center gap-2 h-10 px-3 rounded-xl border transition-all cursor-pointer ${
              unreadCount > 0
                ? "bg-orange-50/90 border-orange-200 text-[#BF4B24] hover:bg-orange-100/80"
                : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-slate-900"
            } ${hasNewPulse ? "ring-4 ring-[#BF4B24]/25 scale-105" : ""}`}
          >
            <Bell
              className={`w-4 h-4 transition-transform ${
                hasNewPulse ? "animate-bounce" : ""
              }`}
            />
            <span className="hidden sm:inline text-xs font-bold">
              Notificações
            </span>
            {unreadCount > 0 && (
              <span className="inline-flex items-center justify-center min-w-[22px] h-5 px-1.5 rounded-full bg-[#BF4B24] text-white text-[10px] font-black tabular-nums">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </button>
        </SheetTrigger>

        <SheetContent className="w-full sm:max-w-md md:max-w-lg p-0 flex flex-col bg-[#FAF7F4] border-l border-slate-200 z-[9999]">
          <div className="bg-white px-6 pt-6 pb-4 border-b border-slate-200/90">
            <SheetHeader className="space-y-1 text-left">
              <div className="flex items-center justify-between gap-2 pr-6">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl bg-[#BF4B24]/10 text-[#BF4B24] flex items-center justify-center">
                    <Bell className="w-4 h-4" />
                  </div>
                  <div>
                    <SheetTitle className="text-lg font-black text-slate-900 tracking-tight flex items-center gap-2">
                      Radar da Plataforma
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                        Ao Vivo
                      </span>
                    </SheetTitle>
                    <SheetDescription className="text-xs text-slate-500">
                      Clique em qualquer notificação para abrir o Raio-X
                      completo.
                    </SheetDescription>
                  </div>
                </div>
              </div>
            </SheetHeader>

            <div className="flex items-center justify-between gap-2 mt-4 pt-3 border-t border-slate-100">
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleMarkAllAsRead}
                  disabled={unreadCount === 0}
                  className="h-8 text-[11px] font-bold border-slate-200 text-slate-700 rounded-lg cursor-pointer"
                >
                  <CheckCheck className="w-3.5 h-3.5 mr-1.5 text-emerald-600" />
                  Ler todas ({unreadCount})
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleClearRead}
                  disabled={notifications.length === 0}
                  className="h-8 text-[11px] font-semibold text-slate-500 hover:text-red-600 rounded-lg cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5 mr-1" />
                  {notifications.length - unreadCount > 0
                    ? `Limpar lidas (${notifications.length - unreadCount})`
                    : "Limpar tudo"}
                </Button>
              </div>

              <button
                type="button"
                onClick={() => setSoundEnabled((prev) => !prev)}
                className={`h-8 px-2.5 rounded-lg border text-[11px] font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer ${
                  soundEnabled
                    ? "bg-slate-900 text-white border-slate-900"
                    : "bg-slate-100 text-slate-500 border-slate-200"
                }`}
              >
                {soundEnabled ? (
                  <>
                    <Volume2 className="w-3.5 h-3.5 text-amber-400" />
                    Som On
                  </>
                ) : (
                  <>
                    <VolumeX className="w-3.5 h-3.5" />
                    Mudo
                  </>
                )}
              </button>
            </div>

            <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar mt-3 pt-1">
              {[
                { id: "all", label: `Todas (${countsByCategory.all})` },
                {
                  id: "unread",
                  label: `Não lidas (${countsByCategory.unread})`,
                },
                {
                  id: "bookings",
                  label: `Reservas (${countsByCategory.bookings})`,
                },
                {
                  id: "cancellations",
                  label: `Cancelamentos (${countsByCategory.cancellations})`,
                },
                {
                  id: "users",
                  label: `Cadastros (${countsByCategory.users})`,
                },
                {
                  id: "rooms",
                  label: `Salas (${countsByCategory.rooms})`,
                },
              ].map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveFilter(tab.id as FilterCategory)}
                  className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold whitespace-nowrap transition-all cursor-pointer ${
                    activeFilter === tab.id
                      ? "bg-[#BF4B24] text-white shadow-2xs"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200/70"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
            {loading ? (
              <div className="flex flex-col items-center justify-center h-64 text-slate-400 gap-2">
                <Loader2 className="w-7 h-7 animate-spin text-[#BF4B24]" />
                <p className="text-xs font-medium">
                  Carregando histórico de eventos...
                </p>
              </div>
            ) : filteredNotifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-64 text-center px-6">
                <div className="w-12 h-12 rounded-2xl bg-slate-200/70 text-slate-400 flex items-center justify-center mb-3">
                  <Bell className="w-6 h-6" />
                </div>
                <p className="text-sm font-bold text-slate-700">
                  Nenhuma notificação neste filtro
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  Assim que um profissional agendar, cancelar ou se cadastrar,
                  ou um anfitrião publicar uma sala, você verá aqui em tempo
                  real.
                </p>
              </div>
            ) : (
              filteredNotifications.map((item) => {
                const visual = getEventVisuals(item.event_type);
                const IconComponent = visual.icon;

                let relativeTime = "";
                let exactTime = "";
                try {
                  const parsed = parseISO(item.created_at);
                  relativeTime = formatDistanceToNow(parsed, {
                    addSuffix: true,
                    locale: ptBR,
                  });
                  exactTime = format(parsed, "dd/MM/yyyy 'às' HH:mm", {
                    locale: ptBR,
                  });
                } catch {
                  relativeTime = "recentemente";
                }

                return (
                  <div
                    key={item.id}
                    onClick={() => handleNotificationClick(item)}
                    className={`group relative rounded-2xl border p-4 transition-all cursor-pointer ${
                      !item.is_read
                        ? "bg-white border-orange-200/90 shadow-xs hover:border-[#BF4B24]"
                        : "bg-white/75 border-slate-200/70 opacity-80 hover:opacity-100 hover:bg-white"
                    }`}
                  >
                    <div className="absolute top-3.5 right-3.5 flex items-center gap-1.5">
                      {!item.is_read && (
                        <button
                          type="button"
                          title="Marcar como lida"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleMarkAsRead(item.id);
                          }}
                          className="w-6 h-6 rounded-full flex items-center justify-center hover:bg-orange-50"
                        >
                          <span className="w-2.5 h-2.5 rounded-full bg-[#BF4B24] ring-4 ring-orange-100" />
                        </button>
                      )}
                      <button
                        type="button"
                        title="Remover notificação"
                        onClick={(e) => handleDeleteOne(e, item.id)}
                        className="opacity-0 group-hover:opacity-100 p-1 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 transition-all"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <div className="flex items-start gap-3.5">
                      <div
                        className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 mt-0.5 ${visual.bgIcon}`}
                      >
                        <IconComponent className="w-5 h-5" />
                      </div>

                      <div className="flex-1 min-w-0 pr-6">
                        <div className="flex items-center gap-2 mb-1">
                          <Badge
                            className={`${visual.badgeClass} border-0 text-[10px] font-bold px-2 py-0`}
                          >
                            {visual.badgeText}
                          </Badge>
                          <span
                            title={exactTime}
                            className="text-[11px] font-medium text-slate-400"
                          >
                            {relativeTime}
                          </span>
                        </div>

                        <h4 className="text-xs font-extrabold text-slate-900 leading-snug">
                          {item.title}
                        </h4>

                        <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                          {item.message}
                        </p>

                        <div className="mt-2.5 flex items-center justify-between text-[11px] text-slate-400">
                          <span>{exactTime}</span>
                          <span className="inline-flex items-center gap-0.5 font-bold text-[#BF4B24] group-hover:translate-x-0.5 transition-transform">
                            Ver detalhes completos{" "}
                            <ChevronRight className="w-3 h-3" />
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* MODAL DE RAIO-X COMPLETO DA NOTIFICAÇÃO */}
      <Dialog
        open={Boolean(selectedDetailItem)}
        onOpenChange={(o) => !o && setSelectedDetailItem(null)}
      >
        <DialogContent className="sm:max-w-md bg-white rounded-2xl border border-slate-200 z-[10000]">
          {selectedDetailItem && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-2 mb-1">
                  <Badge className="bg-orange-50 text-[#BF4B24] border-0 text-[10px] font-bold">
                    Raio-X do Evento
                  </Badge>
                  <span className="text-xs text-slate-400">
                    {selectedDetailItem.created_at
                      ? format(
                          parseISO(selectedDetailItem.created_at),
                          "dd/MM/yyyy 'às' HH:mm",
                          { locale: ptBR },
                        )
                      : ""}
                  </span>
                </div>
                <DialogTitle className="text-base font-black text-slate-900">
                  {selectedDetailItem.title}
                </DialogTitle>
                <DialogDescription className="text-xs text-slate-600 pt-1">
                  {selectedDetailItem.message}
                </DialogDescription>
              </DialogHeader>

              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200/80 space-y-2.5 text-xs">
                {selectedDetailItem.metadata?.user_name && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-500 flex items-center gap-1.5">
                      <User className="w-3.5 h-3.5 text-slate-400" />
                      Profissional / Usuário:
                    </span>
                    <strong className="text-slate-900 text-right">
                      {selectedDetailItem.metadata.user_name}
                    </strong>
                  </div>
                )}

                {selectedDetailItem.metadata?.user_specialty && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-500">Especialidade:</span>
                    <strong className="text-slate-800">
                      {selectedDetailItem.metadata.user_specialty}
                    </strong>
                  </div>
                )}

                {selectedDetailItem.metadata?.user_email && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-500 flex items-center gap-1.5">
                      <Mail className="w-3.5 h-3.5 text-slate-400" />
                      E-mail:
                    </span>
                    <span className="font-semibold text-slate-800 truncate max-w-[210px]">
                      {selectedDetailItem.metadata.user_email}
                    </span>
                  </div>
                )}

                {selectedDetailItem.metadata?.user_phone && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-500 flex items-center gap-1.5">
                      <Phone className="w-3.5 h-3.5 text-slate-400" />
                      WhatsApp / Telefone:
                    </span>
                    <span className="font-semibold text-slate-800">
                      {selectedDetailItem.metadata.user_phone}
                    </span>
                  </div>
                )}

                {selectedDetailItem.metadata?.user_cpf && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-500 flex items-center gap-1.5">
                      <FileText className="w-3.5 h-3.5 text-slate-400" />
                      CPF:
                    </span>
                    <span className="font-semibold text-slate-800">
                      {selectedDetailItem.metadata.user_cpf}
                    </span>
                  </div>
                )}

                {selectedDetailItem.metadata?.room_name && (
                  <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-200/70">
                    <span className="text-slate-500 flex items-center gap-1.5">
                      <DoorOpen className="w-3.5 h-3.5 text-[#BF4B24]" />
                      Sala / Consultório:
                    </span>
                    <strong className="text-slate-900">
                      {selectedDetailItem.metadata.room_name}
                    </strong>
                  </div>
                )}

                {selectedDetailItem.metadata?.date && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-500 flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 text-slate-400" />
                      Data e Horário:
                    </span>
                    <strong className="text-[#BF4B24]">
                      {selectedDetailItem.metadata.date}
                      {selectedDetailItem.metadata.first_hour
                        ? ` às ${selectedDetailItem.metadata.first_hour}`
                        : ""}
                    </strong>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedDetailItem(null)}
                  className="text-xs font-semibold"
                >
                  Fechar
                </Button>

                {onNavigateTab && selectedDetailItem.metadata?.target_tab && (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      const targetTab = selectedDetailItem.metadata.target_tab!;
                      const meta = selectedDetailItem.metadata;
                      setSelectedDetailItem(null);
                      setIsOpen(false);
                      onNavigateTab(targetTab, meta);
                    }}
                    className="bg-[#BF4B24] hover:bg-[#9A3C1D] text-white text-xs font-bold rounded-xl cursor-pointer"
                  >
                    <span>Abrir módulo correspondente</span>
                    <ExternalLink className="w-3.5 h-3.5 ml-1.5" />
                  </Button>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
