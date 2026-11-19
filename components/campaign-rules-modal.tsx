// components/campaign-rules-modal.tsx
"use client";

import { X, FileText, ShieldCheck, Flame } from "lucide-react";

export interface CampaignRulesModalProps {
  isOpen: boolean;
  onClose: () => void;
  campaignName?: string | null;
  rulesText?: string | null;
  badgeText?: string | null;
}

/**
 * Extrai o texto de regulamento salvo em schedule_rules.rules_text de qualquer campanha da tabela coupons.
 */
export function extractCampaignRulesText(coupon: any): string | null {
  if (!coupon) return null;
  let rules = coupon.schedule_rules;
  if (typeof rules === "string") {
    try {
      rules = JSON.parse(rules);
    } catch {
      rules = null;
    }
  }
  const rawText = rules?.rules_text ?? coupon.rules_text ?? null;
  if (typeof rawText === "string" && rawText.trim().length > 0) {
    return rawText.trim();
  }
  return null;
}

export function CampaignRulesModal({
  isOpen,
  onClose,
  campaignName,
  rulesText,
  badgeText,
}: CampaignRulesModalProps) {
  if (!isOpen || !rulesText || !rulesText.trim()) return null;

  const lines = rulesText
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim());

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Regulamento da Campanha"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      className="fixed inset-0 z-[9998] flex items-center justify-center p-4 sm:p-6 bg-black/75 backdrop-blur-[2px] animate-in fade-in duration-150 font-sans"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-lg max-h-[86dvh] bg-white rounded-3xl shadow-2xl border border-stone-200 overflow-hidden flex flex-col animate-in zoom-in-95 duration-200"
      >
        {/* Cabeçalho escuro de alto contraste */}
        <div className="bg-[#09090B] text-white px-5 sm:px-6 py-4 sm:py-5 border-b border-white/10 flex items-start justify-between gap-3 shrink-0">
          <div className="space-y-1 pr-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-amber-400/15 border border-amber-400/40 text-[#FBBF24] text-[10px] font-black uppercase tracking-wider">
                <Flame className="w-3 h-3 fill-[#FBBF24]" />
                {campaignName || "Campanha Promocional"}
              </span>
              {badgeText && (
                <span className="px-2 py-0.5 rounded-full bg-white/10 text-white text-[10px] font-extrabold">
                  {badgeText}
                </span>
              )}
            </div>
            <h2 className="text-base sm:text-lg font-black text-white flex items-center gap-2">
              <FileText className="w-4 h-4 text-[#FBBF24] shrink-0" />
              Regulamento da Campanha
            </h2>
          </div>

          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }}
            aria-label="Fechar regulamento"
            className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center shrink-0 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4 stroke-[2.5]" />
          </button>
        </div>

        {/* Corpo com formatação inteligente das regras */}
        <div className="flex-1 overflow-y-auto px-5 sm:px-6 py-5 space-y-3 text-stone-700">
          {lines.map((line, idx) => {
            if (!line) {
              return <div key={idx} className="h-1" />;
            }

            const numberedMatch = line.match(/^(\d+)\.\s*(.*)$/);
            if (numberedMatch) {
              const itemNumber = numberedMatch[1];
              const restText = numberedMatch[2];
              const colonIdx = restText.indexOf(":");
              const hasLabel = colonIdx > 0 && colonIdx <= 35;
              const labelPart = hasLabel ? restText.slice(0, colonIdx + 1) : "";
              const bodyPart = hasLabel
                ? restText.slice(colonIdx + 1).trim()
                : restText;

              return (
                <div
                  key={idx}
                  className="flex items-start gap-3 p-3 rounded-2xl bg-[#FAF7F4] border border-stone-200/80"
                >
                  <span className="w-6 h-6 rounded-lg bg-stone-900 text-[#FBBF24] text-xs font-black flex items-center justify-center shrink-0 mt-0.5 tabular-nums">
                    {itemNumber}
                  </span>
                  <p className="text-xs sm:text-[13px] leading-relaxed text-stone-700">
                    {hasLabel && (
                      <strong className="font-extrabold text-stone-950 mr-1">
                        {labelPart}
                      </strong>
                    )}
                    {bodyPart}
                  </p>
                </div>
              );
            }

            const isShortHeading =
              line.length <= 48 && !line.endsWith(".") && !line.includes(":");
            if (isShortHeading) {
              return (
                <p
                  key={idx}
                  className="text-xs font-black uppercase tracking-wider text-[#BF4B24] pt-1"
                >
                  {line}
                </p>
              );
            }

            return (
              <p
                key={idx}
                className="text-xs sm:text-[13px] leading-relaxed text-stone-600 bg-stone-50 border border-stone-200/70 rounded-xl p-3.5"
              >
                {line}
              </p>
            );
          })}
        </div>

        {/* Rodapé */}
        <div className="px-5 sm:px-6 py-3.5 bg-stone-50 border-t border-stone-200/80 flex items-center justify-between gap-3 shrink-0">
          <span className="text-[11px] font-semibold text-stone-500 flex items-center gap-1.5">
            <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
            Condições oficiais da campanha
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="px-5 h-10 rounded-xl bg-stone-900 hover:bg-stone-800 text-white font-bold text-xs transition-colors cursor-pointer shrink-0"
          >
            Entendi
          </button>
        </div>
      </div>
    </div>
  );
}
