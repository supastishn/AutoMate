import React from "react";
import { useColors } from '../ThemeContext'

interface DoctorResponse {
  ok: string[];
  issues: string[];
  total: { passed: number; warnings: number };
}

type Severity = "ok" | "warn" | "info";

function parseLine(raw: string): { severity: Severity; text: string } {
  if (raw.startsWith("[OK]")) return { severity: "ok", text: raw.slice(4).trim() };
  if (raw.startsWith("[WARN]")) return { severity: "warn", text: raw.slice(6).trim() };
  if (raw.startsWith("[INFO]")) return { severity: "info", text: raw.slice(6).trim() };
  return { severity: "info", text: raw.trim() };
}

const fadeInKeyframes = `
@keyframes doctor-fade-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
`;

const Doctor: React.FC = () => {
  const colors = useColors()
  const [data, setData] = React.useState<DoctorResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [lastRun, setLastRun] = React.useState<Date | null>(null);

  const dotColor: Record<Severity, string> = {
    ok: colors.success,
    warn: colors.warning,
    info: colors.accent,
  };

  const fetchAudit = React.useCallback(() => {
    setLoading(true);
    fetch("/api/doctor")
      .then((r) => r.json())
      .then((d: DoctorResponse) => {
        setData(d);
        setLastRun(new Date());
      })
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    fetchAudit();
  }, [fetchAudit]);

  const fadeInStyle: React.CSSProperties = {
    animation: "doctor-fade-in 0.4s ease-out",
  };

  return (
    <div style={{
      background: colors.bgPrimary,
      minHeight: "100vh",
      padding: "32px 24px",
      color: colors.textPrimary,
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    }}>
      <style>{fadeInKeyframes}</style>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, color: colors.textPrimary, margin: 0 }}>Security Audit</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {lastRun && (
            <span style={{ fontSize: 12, color: colors.inputPlaceholder, fontFamily: "monospace" }}>
              Last run: {lastRun.toLocaleTimeString()}
            </span>
          )}
          <button
            style={{
              background: loading ? colors.borderLight : colors.accent,
              color: loading ? colors.textSecondary : colors.accentContrast,
              border: "none",
              borderRadius: 6,
              padding: "10px 20px",
              fontSize: 14,
              fontWeight: 600,
              cursor: loading ? "not-allowed" : "pointer",
            }}
            disabled={loading}
            onClick={fetchAudit}
          >
            Re-run Audit
          </button>
        </div>
      </div>

      {loading && (
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 64,
          color: colors.textSecondary,
          fontSize: 15,
        }}>Running audit...</div>
      )}

      {!loading && data && (
        <div style={fadeInStyle}>
          {/* Summary */}
          <div style={{
            background: colors.bgCard,
            border: `1px solid ${colors.border}`,
            borderRadius: 10,
            padding: "20px 28px",
            marginBottom: 28,
            display: "flex",
            gap: 32,
            alignItems: "center",
            flexWrap: "wrap" as const,
          }}>
            <span style={{ fontSize: 16, fontWeight: 600, fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace", color: colors.success }}>
              {data.total.passed} passed
            </span>
            <span style={{ fontSize: 16, fontWeight: 600, fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace", color: colors.warning }}>
              {data.total.warnings} warnings/info
            </span>
          </div>

          {/* Passed */}
          {data.ok.length > 0 && (
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 18, fontWeight: 600, color: colors.textPrimary, marginBottom: 12 }}>Passed</div>
              <div style={{
                background: colors.bgCard,
                border: `1px solid ${colors.border}`,
                borderRadius: 8,
                overflow: "hidden",
              }}>
                {data.ok.map((line, i) => {
                  const parsed = parseLine(line);
                  return (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: "12px 20px",
                        borderBottom: i === data.ok.length - 1 ? "none" : `1px solid ${colors.bgHover}`,
                        fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
                        fontSize: 13,
                        lineHeight: 1.5,
                      }}
                    >
                      <span style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: dotColor.ok }} />
                      <span>{parsed.text}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Issues */}
          {data.issues.length > 0 && (
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 18, fontWeight: 600, color: colors.textPrimary, marginBottom: 12 }}>Issues</div>
              <div style={{
                background: colors.bgCard,
                border: `1px solid ${colors.border}`,
                borderRadius: 8,
                overflow: "hidden",
              }}>
                {data.issues.map((line, i) => {
                  const parsed = parseLine(line);
                  return (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: "12px 20px",
                        borderBottom: i === data.issues.length - 1 ? "none" : `1px solid ${colors.bgHover}`,
                        fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
                        fontSize: 13,
                        lineHeight: 1.5,
                      }}
                    >
                      <span style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: dotColor[parsed.severity] }} />
                      <span>{parsed.text}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {!loading && !data && (
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 64,
          color: colors.textSecondary,
          fontSize: 15,
        }}>
          Failed to fetch audit data. Click Re-run Audit to try again.
        </div>
      )}
    </div>
  );
};

export default Doctor;
