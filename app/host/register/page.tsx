"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { sendWelcomeEmail } from "@/app/actions/send-email";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Building2,
  ArrowLeft,
  AlertCircle,
  Loader2,
  RefreshCw,
  MailCheck,
} from "lucide-react";

type HostRegisterStep = "register" | "verify_otp";

export default function HostRegisterPage() {
  const router = useRouter();
  const [supabase] = useState(() => createClient());
  const { toast } = useToast();

  const [step, setStep] = useState<HostRegisterStep>("register");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ensureHostRole = async (userId: string, name: string) => {
    try {
      const { data: profile } = await supabase
        .from("profiles")
        .select("role, full_name")
        .eq("id", userId)
        .maybeSingle();

      if (profile && !profile.role) {
        await supabase
          .from("profiles")
          .update({
            role: "host",
            ...(name && !profile.full_name ? { full_name: name } : {}),
          })
          .eq("id", userId);
      }
    } catch {}
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const cleanEmail = email.trim();
    const cleanName = fullName.trim();

    if (password.length < 6) {
      setError("A senha deve ter pelo menos 6 caracteres.");
      return;
    }

    setLoading(true);
    try {
      const { data: signUpData, error: signUpError } =
        await supabase.auth.signUp({
          email: cleanEmail,
          password,
          options: {
            data: {
              full_name: cleanName,
              role: "host",
            },
            emailRedirectTo: `${window.location.origin}/auth/callback`,
          },
        });

      if (signUpError) throw signUpError;

      if (
        signUpData.user &&
        Array.isArray(signUpData.user.identities) &&
        signUpData.user.identities.length === 0
      ) {
        setError(
          "Este e-mail já está cadastrado. Volte para o login para acessar sua conta.",
        );
        return;
      }

      if (signUpData.user && !signUpData.session) {
        toast({
          title: "Código enviado para seu e-mail!",
          description: `Digite o código de 6 dígitos enviado para ${cleanEmail}.`,
        });
        setOtpCode("");
        setStep("verify_otp");
        return;
      }

      if (signUpData.user) {
        await ensureHostRole(signUpData.user.id, cleanName);
      }

      await sendWelcomeEmail(cleanEmail, cleanName).catch(() => {});

      toast({
        title: "Conta de Anfitrião criada!",
        description: "Bem-vindo à Fusion Clinic. Configurando seu painel...",
      });

      router.push("/host");
      router.refresh();
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Erro ao criar conta. Verifique os dados.");
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const cleanCode = otpCode.replace(/\D/g, "");
    if (cleanCode.length < 6) {
      setError("Digite os 6 dígitos do código enviado para o seu e-mail.");
      return;
    }

    setLoading(true);
    try {
      const cleanEmail = email.trim();
      const { data, error: otpError } = await supabase.auth.verifyOtp({
        email: cleanEmail,
        token: cleanCode,
        type: "signup",
      });

      if (otpError) throw otpError;

      const resolvedName =
        fullName.trim() || data.user?.user_metadata?.full_name || "Anfitrião";

      if (data.user) {
        await ensureHostRole(data.user.id, resolvedName);
      }

      await sendWelcomeEmail(cleanEmail, resolvedName).catch(() => {});

      toast({
        title: "E-mail confirmado com sucesso!",
        description: "Sua conta de anfitrião foi ativada.",
      });

      router.push("/host");
      router.refresh();
    } catch (err: any) {
      setError("Código inválido ou expirado. Tente novamente ou reenvie.");
    } finally {
      setLoading(false);
    }
  };

  const handleResendCode = async () => {
    if (!email.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const { error: resendErr } = await supabase.auth.resend({
        type: "signup",
        email: email.trim(),
      });
      if (resendErr) throw resendErr;
      toast({
        title: "Código reenviado!",
        description: `Verifique sua caixa de entrada e spam em ${email.trim()}.`,
      });
    } catch (err: any) {
      setError(err.message || "Não foi possível reenviar o código.");
    } finally {
      setLoading(false);
    }
  };

  const handleBack = () => {
    setError(null);
    if (step === "verify_otp") {
      setStep("register");
    } else {
      router.push("/login");
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 p-4">
      <div className="w-full max-w-md mb-4 flex justify-start">
        <button
          type="button"
          onClick={handleBack}
          className="flex items-center text-sm font-bold text-slate-500 hover:text-slate-900 transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4 mr-1" />
          {step === "verify_otp"
            ? "Voltar para o cadastro"
            : "Voltar para o Login"}
        </button>
      </div>

      <Card className="w-full max-w-md shadow-xl border-slate-100 rounded-2xl overflow-hidden">
        <div className="h-2 w-full bg-slate-900" />

        <CardHeader className="space-y-2 text-center pt-8 pb-6">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 mb-2">
            {step === "verify_otp" ? (
              <MailCheck className="w-6 h-6 text-[#BF4B24]" />
            ) : (
              <Building2 className="w-6 h-6 text-slate-900" />
            )}
          </div>
          <CardTitle className="text-2xl font-black text-slate-900 tracking-tight">
            {step === "verify_otp"
              ? "Confirme seu e-mail"
              : "Seja um Anfitrião"}
          </CardTitle>
          <CardDescription className="text-slate-500 font-medium px-2">
            {step === "verify_otp"
              ? `Digite o código de 6 dígitos enviado para ${email.trim()}`
              : "Cadastre seus espaços e maximize sua rentabilidade."}
          </CardDescription>
        </CardHeader>

        <CardContent className="px-6 pb-8">
          {error && (
            <div className="flex items-center gap-2 bg-red-50 text-red-600 p-3 rounded-lg text-sm font-medium mb-4">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <p>{error}</p>
            </div>
          )}

          {step === "register" ? (
            <form onSubmit={handleRegister} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="fullName">Nome do Responsável ou Clínica</Label>
                <Input
                  id="fullName"
                  type="text"
                  placeholder="Ex: Clínica Bem Estar"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required
                  className="h-12 bg-slate-50 border-slate-200 rounded-xl"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">E-mail Comercial</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="contato@clinica.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="h-12 bg-slate-50 border-slate-200 rounded-xl"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Senha</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="Crie uma senha segura"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={6}
                  className="h-12 bg-slate-50 border-slate-200 rounded-xl"
                />
              </div>
              <Button
                type="submit"
                className="w-full h-12 rounded-xl mt-2 font-bold bg-slate-900 hover:bg-slate-800 cursor-pointer"
                disabled={loading}
              >
                {loading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  "Criar Conta de Anfitrião"
                )}
              </Button>
            </form>
          ) : (
            <form onSubmit={handleVerifyOtp} className="space-y-4">
              <div className="space-y-2">
                <Label
                  htmlFor="otpCode"
                  className="text-xs font-bold text-slate-600"
                >
                  Código de Verificação (6 dígitos)
                </Label>
                <Input
                  id="otpCode"
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="000000"
                  value={otpCode}
                  onChange={(e) =>
                    setOtpCode(e.target.value.replace(/\D/g, ""))
                  }
                  required
                  className="h-12 bg-slate-50 border-slate-200 rounded-xl text-center text-lg font-black tracking-[0.35em]"
                />
              </div>

              <Button
                type="submit"
                className="w-full h-12 rounded-xl mt-2 font-bold bg-[#BF4B24] hover:bg-[#9A3C1D] text-white cursor-pointer"
                disabled={loading}
              >
                {loading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  "Confirmar Código e Ativar Conta"
                )}
              </Button>

              <button
                type="button"
                onClick={handleResendCode}
                disabled={loading}
                className="w-full flex items-center justify-center gap-1.5 text-xs font-bold text-slate-500 hover:text-[#BF4B24] pt-1 transition-colors cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Não recebeu? Reenviar
                código
              </button>
            </form>
          )}

          <div className="mt-6 pt-5 border-t border-slate-100">
            <p className="text-[11px] text-center text-slate-500 leading-relaxed max-w-sm mx-auto">
              Ao continuar, você declara ter lido e concorda com os{" "}
              <Link
                href="/termos"
                className="font-bold text-slate-700 underline hover:text-[#BF4B24] transition-colors"
              >
                Termos de Uso
              </Link>
              , a{" "}
              <Link
                href="/privacidade"
                className="font-bold text-slate-700 underline hover:text-[#BF4B24] transition-colors"
              >
                Política de Privacidade
              </Link>{" "}
              e a{" "}
              <Link
                href="/cookies"
                className="font-bold text-slate-700 underline hover:text-[#BF4B24] transition-colors"
              >
                Política de Cookies
              </Link>{" "}
              da Fusion Clinic.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
