"use client";

import { useState, useEffect } from "react";
import { format, differenceInSeconds, parseISO, addMinutes } from "date-fns";
import {
  QrCode,
  AlertTriangle,
  CheckCircle2,
  AlertOctagon,
  Loader2,
  Clock,
  PlusCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { createClient } from "@/utils/supabase/client";
import { RoomQRScanner } from "@/components/qr-scanner";
import { performRoomCheckoutAction } from "@/app/actions/room-session";

interface ActiveSessionProps {
  booking: any;
  onSessionEnd: () => void;
}

export function ActiveSession({ booking, onSessionEnd }: ActiveSessionProps) {
  const [supabase] = useState(() => createClient());
  const { toast } = useToast();

  const [loading, setLoading] = useState(false);
  const [extending, setExtending] = useState(false);
  const [secondsElapsed, setSecondsElapsed] = useState(0);
  const [sessionPhase, setSessionPhase] = useState<
    "early" | "running" | "overtime"
  >("early");
  const [overstayInfo, setOverstayInfo] = useState<
    "checking" | "free" | "occupied"
  >("checking");
  const [showScanner, setShowScanner] = useState(false);

  useEffect(() => {
    if (!booking || showScanner) return;

    const updateTimer = () => {
      const now = new Date();
      const startTime = parseISO(booking.start_time);
      const endTime = parseISO(booking.end_time);

      if (now < startTime) {
        setSessionPhase("early");
        setSecondsElapsed(0);
      } else if (now >= startTime && now <= endTime) {
        setSessionPhase("running");
        setSecondsElapsed(differenceInSeconds(now, startTime));
      } else {
        setSessionPhase("overtime");
        setSecondsElapsed(differenceInSeconds(now, startTime));
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [booking, showScanner]);

  useEffect(() => {
    if (sessionPhase === "overtime") {
      const checkAvailability = async () => {
        const eTime = parseISO(booking.end_time);
        const limit = new Date(eTime.getTime() + 60 * 60 * 1000);

        const { data } = await supabase
          .from("bookings")
          .select("id")
          .eq("room_id", booking.room_id)
          .neq("id", booking.id)
          .gte("start_time", eTime.toISOString())
          .lt("start_time", limit.toISOString())
          .in("status", ["confirmed", "pending_payment", "in_progress"]);

        setOverstayInfo(data && data.length > 0 ? "occupied" : "free");
      };
      checkAvailability();
    }
  }, [sessionPhase, booking.end_time, booking.room_id, booking.id, supabase]);

  const startObj = parseISO(booking.start_time);
  const endObj = parseISO(booking.end_time);
  const endFormatted = format(endObj, "HH:mm");
  const fineStartFormatted = format(addMinutes(endObj, 1), "HH:mm");

  const totalSessionMinutes = differenceInSeconds(endObj, startObj) / 60;
  const warningThreshold = totalSessionMinutes - 10;

  const minutesElapsed = Math.floor(secondsElapsed / 60);
  const secondsReminder = secondsElapsed % 60;

  let statusColor = "bg-emerald-500";
  let bgGlow = "bg-emerald-50";
  let statusText = "Sessão em andamento";
  let statusIcon = <CheckCircle2 className="w-5 h-5 text-emerald-500" />;

  if (sessionPhase === "early") {
    statusColor = "bg-blue-500";
    bgGlow = "bg-blue-50";
    statusText = "Aguardando Início Oficial";
    statusIcon = <Clock className="w-5 h-5 text-blue-500" />;
  } else if (sessionPhase === "running" && minutesElapsed >= warningThreshold) {
    statusColor = "bg-amber-500";
    bgGlow = "bg-amber-50";
    statusText = `Últimos minutos • Check-out até ${endFormatted}`;
    statusIcon = <AlertTriangle className="w-5 h-5 text-amber-500" />;
  } else if (sessionPhase === "overtime") {
    statusColor = "bg-red-500";
    bgGlow = "bg-red-50";
    statusText =
      overstayInfo === "occupied"
        ? `Tempo esgotado! Próximo profissional aguardando (multa às ${fineStartFormatted}).`
        : `Horário encerrado! Multa por atraso a partir das ${fineStartFormatted}.`;
    statusIcon = <AlertOctagon className="w-5 h-5 text-red-500" />;
  }

  const handleExtendSession = async () => {
    setExtending(true);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Usuário não autenticado");

      const currentEndTime = parseISO(booking.end_time);
      const newEndTime = new Date(
        currentEndTime.getTime() + 60 * 60 * 1000,
      ).toISOString();

      const idsToUpdate = booking.original_ids || [booking.id];
      const baseCost =
        booking.total_cost > 0 ? booking.total_cost / idsToUpdate.length : 45;

      const { error: walletError } = await supabase
        .from("wallet_transactions")
        .insert({
          user_id: user.id,
          amount: -baseCost,
          type: "usage",
          tier: booking.rooms?.tier || "start",
          description: `Extensão Rápida (+1h): ${booking.rooms?.name}`,
        });
      if (walletError) throw walletError;

      const { error: updateError } = await supabase
        .from("bookings")
        .update({
          end_time: newEndTime,
          total_cost: booking.total_cost + baseCost,
        })
        .eq("id", idsToUpdate[idsToUpdate.length - 1]);

      if (updateError) throw updateError;

      toast({
        title: "Sessão Estendida! ⏳",
        description: "Você comprou mais 1 hora de uso com sucesso.",
      });
      onSessionEnd();
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Erro ao estender",
        description: error.message,
      });
    } finally {
      setExtending(false);
    }
  };

  const processCheckout = async () => {
    setLoading(true);
    setShowScanner(false);

    try {
      const idsToUpdate = booking.original_ids || [booking.id];
      const result = await performRoomCheckoutAction({
        bookingIds: idsToUpdate,
        roomId: booking.room_id,
      });

      if (!result.success) {
        throw new Error(result.message);
      }

      if (result.penaltyStatus === "fined") {
        toast({
          variant: "destructive",
          title: "Check-out com Multa",
          description: `Você finalizou após as ${fineStartFormatted}. O recibo foi enviado no WhatsApp e e-mail.`,
        });
      } else if (result.penaltyStatus === "warning") {
        toast({
          title: "Check-out concluído no limite",
          description:
            "Saída registrada antes do horário de multa. Recibo enviado no WhatsApp e e-mail.",
        });
      } else {
        toast({
          title: "Check-out concluído! 👏",
          description:
            "Obrigado por deixar a sala organizada. Recibo enviado no WhatsApp e e-mail!",
        });
      }

      onSessionEnd();
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Erro no Check-out",
        description: error.message,
      });
      setLoading(false);
    }
  };

  return (
    <>
      <div className="max-w-2xl mx-auto w-full p-4 mt-6 animate-in zoom-in-95 duration-500">
        <div
          className={`rounded-[2rem] border-2 shadow-2xl overflow-hidden transition-all duration-300 ${showScanner ? "scale-95 opacity-50 blur-sm" : ""} ${sessionPhase === "overtime" ? "border-red-200" : sessionPhase === "running" && minutesElapsed >= warningThreshold ? "border-amber-200" : sessionPhase === "early" ? "border-blue-200" : "border-emerald-200"}`}
        >
          <div
            className={`p-8 text-center ${bgGlow} transition-colors duration-500`}
          >
            <div className="inline-flex items-center justify-center p-3 bg-white rounded-2xl shadow-sm mb-6">
              <QrCode className="w-8 h-8 text-slate-800" />
            </div>
            <h2 className="text-xl font-bold text-slate-800 mb-1">
              {booking.rooms?.name || "Sua Sala"}
            </h2>
            <div className="flex items-center justify-center gap-2 mb-8 bg-white/50 w-fit mx-auto px-4 py-2 rounded-full border border-slate-200/50 backdrop-blur-sm">
              {statusIcon}
              <span className="text-sm font-black uppercase tracking-wider text-slate-700">
                {statusText}
              </span>
            </div>

            <div className="font-mono text-7xl md:text-8xl font-black text-slate-900 tracking-tighter tabular-nums mb-2">
              {minutesElapsed.toString().padStart(2, "0")}:
              {secondsReminder.toString().padStart(2, "0")}
            </div>

            {sessionPhase === "early" ? (
              <p className="text-blue-600 font-bold uppercase tracking-widest text-xs animate-pulse">
                O cronômetro iniciará às {format(startObj, "HH:mm")}
              </p>
            ) : (
              <p className="text-slate-500 font-medium uppercase tracking-widest text-xs">
                Tempo de uso • Saída até {endFormatted}
              </p>
            )}
          </div>

          <div className="bg-white p-6 md:p-8 flex flex-col gap-4">
            {sessionPhase === "overtime" && overstayInfo === "free" ? (
              <div className="flex flex-col gap-3">
                <Button
                  onClick={handleExtendSession}
                  disabled={extending}
                  className="w-full h-16 rounded-2xl font-black text-lg bg-emerald-500 hover:bg-emerald-600 text-white shadow-xl transition-all hover:scale-[1.02]"
                >
                  {extending ? (
                    <Loader2 className="w-6 h-6 animate-spin" />
                  ) : (
                    <>
                      <PlusCircle className="w-6 h-6 mr-2" /> Comprar +1 Hora
                    </>
                  )}
                </Button>

                <Button
                  onClick={() => setShowScanner(true)}
                  disabled={loading}
                  variant="outline"
                  className="w-full h-14 rounded-2xl font-bold text-red-600 border-red-200 hover:bg-red-50"
                >
                  Fazer Check-out Atrasado (Multa após {fineStartFormatted})
                </Button>
              </div>
            ) : (
              <>
                {sessionPhase !== "overtime" && (
                  <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100 mb-2">
                    <h4 className="text-xs font-bold uppercase text-slate-400 mb-2 tracking-wider">
                      Regras de Saída
                    </h4>
                    <ul className="text-sm text-slate-600 font-medium space-y-2">
                      <li className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0"></span>
                        50 min de consulta + 10 min finais de organização e
                        saída.
                      </li>
                      <li className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0"></span>
                        Desligue ar-condicionado, luzes e faça check-out até{" "}
                        <strong>{endFormatted}</strong>.
                      </li>
                      <li className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-red-500 shrink-0"></span>
                        A partir das <strong>{fineStartFormatted}</strong> sem
                        check-out: cobrança de multa por atraso.
                      </li>
                    </ul>
                  </div>
                )}

                <Button
                  onClick={() => setShowScanner(true)}
                  disabled={loading || sessionPhase === "early"}
                  className={`w-full h-16 rounded-2xl font-black text-lg text-white shadow-xl transition-all hover:scale-[1.02] ${statusColor}`}
                >
                  {loading ? (
                    <Loader2 className="w-6 h-6 animate-spin" />
                  ) : sessionPhase === "early" ? (
                    "Aguarde o início da sessão..."
                  ) : sessionPhase === "overtime" ? (
                    "Ler QR Code e Finalizar Saída"
                  ) : (
                    "Ler QR Code de Saída"
                  )}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      {showScanner && (
        <RoomQRScanner
          key="checkout-scanner"
          expectedRoomId={booking.room_id}
          type="checkout"
          onSuccess={processCheckout}
          onCancel={() => setShowScanner(false)}
        />
      )}
    </>
  );
}
