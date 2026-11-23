export interface WhatsAppMessagePayload {
  phone: string | null | undefined;
  text: string;
  delayMs?: number;
}

export function normalizeBrazilWhatsApp(
  rawPhone?: string | null,
): string | null {
  if (!rawPhone) return null;
  let digits = String(rawPhone).replace(/\D/g, "").replace(/^0+/, "");
  if (digits.length < 10) return null;
  if (digits.length === 10 || digits.length === 11) {
    digits = `55${digits}`;
  }
  if (digits.length < 12 || digits.length > 13) return null;
  return digits;
}

export function parseEnvAdminWhatsApps(): string[] {
  const raw = process.env.ADMIN_WHATSAPP_NUMBERS || "";
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((item) => normalizeBrazilWhatsApp(item))
    .filter((n): n is string => Boolean(n));
}

export async function sendEvolutionWhatsAppMessage(
  payload: WhatsAppMessagePayload,
): Promise<{ success: boolean; error?: string }> {
  const baseUrl = (process.env.EVOLUTION_API_URL || "")
    .trim()
    .replace(/\/+$/, "");
  const apiKey = (process.env.EVOLUTION_API_KEY || "").trim();
  const instanceName = (process.env.EVOLUTION_INSTANCE_NAME || "").trim();

  if (!baseUrl || !apiKey || !instanceName) {
    return {
      success: false,
      error: "Variáveis da Evolution API não configuradas.",
    };
  }

  const normalizedNumber = normalizeBrazilWhatsApp(payload.phone);
  if (!normalizedNumber || !payload.text?.trim()) {
    return { success: false, error: "Número ou mensagem inválida." };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);

  try {
    const endpoint = `${baseUrl}/message/sendText/${encodeURIComponent(instanceName)}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: apiKey,
      },
      body: JSON.stringify({
        number: normalizedNumber,
        text: payload.text.trim(),
        delay: payload.delayMs ?? 1200,
        linkPreview: false,
      }),
      signal: controller.signal,
      cache: "no-store",
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      console.error(
        `[Evolution API] Falha (${response.status}) para ${normalizedNumber}:`,
        errBody.slice(0, 300),
      );
      return { success: false, error: `HTTP ${response.status}` };
    }

    return { success: true };
  } catch (err: any) {
    console.error(
      `[Evolution API] Exceção ao enviar para ${normalizedNumber}:`,
      err?.message || err,
    );
    return { success: false, error: err?.message || "Erro de conexão" };
  } finally {
    clearTimeout(timeout);
  }
}

export async function dispatchWhatsAppBatch(
  messages: WhatsAppMessagePayload[],
): Promise<{ sentCount: number; failedCount: number }> {
  const validMessages = messages.filter(
    (m) => Boolean(normalizeBrazilWhatsApp(m.phone)) && Boolean(m.text?.trim()),
  );

  if (validMessages.length === 0) {
    return { sentCount: 0, failedCount: 0 };
  }

  const results = await Promise.allSettled(
    validMessages.map((msg, index) =>
      sendEvolutionWhatsAppMessage({
        ...msg,
        delayMs: msg.delayMs ?? 1200 + index * 1400,
      }),
    ),
  );

  let sentCount = 0;
  let failedCount = 0;

  results.forEach((res) => {
    if (res.status === "fulfilled" && res.value.success) {
      sentCount += 1;
    } else {
      failedCount += 1;
    }
  });

  return { sentCount, failedCount };
}