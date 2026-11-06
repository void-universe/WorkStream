// 首次进入的第一步：选界面语言。
// 语言标签本身用当前选中的语言渲染——选一下整屏文字就跟着换，
// 这既是最省事的确认方式，也比一句「已切换」的 toast 更能证明真的生效了。
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DEFAULT_LOCALE,
  LOCALES,
  applyDocumentLocale,
  createI18n,
  pickFromNavigator,
  writeStoredLang,
  type LocaleId,
} from "../lib/i18n";

export function LanguageGate({ onDone }: { onDone: (lang: LocaleId) => void }) {
  const [draft, setDraft] = useState<LocaleId>(() => pickFromNavigator() ?? DEFAULT_LOCALE);
  const i18n = useMemo(() => createI18n(draft), [draft]);
  const available = LOCALES.filter((locale) => locale.complete);
  const pending = LOCALES.filter((locale) => !locale.complete);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center gap-5 px-5 py-10">
      <header className="flex items-center gap-2">
        <span className="grid size-8 place-items-center rounded-lg bg-foreground font-mono text-xs font-bold text-background">{">_"}</span>
        <span className="text-xl font-semibold tracking-tight">WorkStream</span>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{i18n.t("lang.title")}</CardTitle>
          <CardDescription className="text-xs">{i18n.t("lang.hint")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-2">
            <p className="text-xs font-medium text-muted-foreground">{i18n.t("lang.available")}</p>
            <div className="flex flex-wrap gap-2">
              {available.map((locale) => (
                <Button
                  key={locale.id}
                  size="sm"
                  variant={locale.id === draft ? "default" : "outline"}
                  onClick={() => {
                    setDraft(locale.id);
                    applyDocumentLocale(locale.id);
                  }}
                >
                  {locale.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="grid gap-2 rounded-lg border border-border/60 bg-muted/30 p-3">
            <p className="text-xs font-medium text-muted-foreground">{i18n.t("lang.comingSoon")}</p>
            <div className="flex flex-wrap gap-1.5">
              {pending.map((locale) => (
                <span
                  key={locale.id}
                  className="rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground"
                  title={locale.dir === "rtl" ? "RTL" : undefined}
                >
                  {locale.label}
                  {locale.dir === "rtl" ? " · rtl" : ""}
                </span>
              ))}
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">{i18n.tf("lang.comingSoonHint", { n: pending.length })}</p>
          </div>

          <Button
            onClick={() => {
              writeStoredLang(draft);
              applyDocumentLocale(draft);
              onDone(draft);
            }}
          >
            {i18n.t("lang.continue")}
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
