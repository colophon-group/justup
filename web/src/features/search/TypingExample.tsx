import { useEffect, useState } from "react";
import { interfaceExamples } from "../../i18n/examples.ts";
import { useInterfaceLocale } from "../../i18n/LocaleProvider.tsx";
export function TypingExample({
  enabled,
  reducedMotion,
}: {
  enabled: boolean;
  reducedMotion: boolean;
}) {
  const { locale } = useInterfaceLocale();
  const searchExamples = interfaceExamples[locale];
  const [state, setState] = useState({ index: 0, position: 0, erasing: false });
  const [visible, setVisible] = useState(true);
  useEffect(() => { setState({ index: 0, position: 0, erasing: false }); }, [locale]);
  const prompt = searchExamples[state.index] ?? searchExamples[0] ?? "";
  useEffect(() => {
    if (!enabled || reducedMotion || !visible) return;
    const full = state.position === prompt.length,
      empty = state.position === 0;
    const delay =
      full && !state.erasing
        ? 3200 + Math.min(3000, Math.max(0, prompt.length - 70) * 22)
        : state.erasing
          ? 13
          : empty
            ? 350
            : 24;
    const timer = setTimeout(
      () =>
        setState((current) =>
          current.erasing
            ? current.position === 0
              ? {
                  index: (current.index + 1) % searchExamples.length,
                  position: 0,
                  erasing: false,
                }
              : { ...current, position: current.position - 1 }
            : current.position === prompt.length
              ? { ...current, erasing: true }
              : { ...current, position: current.position + 1 },
        ),
      delay,
    );
    return () => clearTimeout(timer);
  }, [enabled, reducedMotion, state, prompt, visible]);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return (
    <span
      className={`query-typing-example${reducedMotion ? " is-static" : ""}`}
      id="query-typing-example"
      aria-hidden="true"
      hidden={!enabled || !visible}
    >
      {reducedMotion ? prompt : prompt.slice(0, state.position)}
    </span>
  );
}
