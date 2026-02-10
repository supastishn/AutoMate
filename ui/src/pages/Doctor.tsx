import React from "react";

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

const dotColor: Record<Severity, string> = {
  ok: "#4caf50",
  warn: "#ff9800",
  info: "#4fc3f7",
};

const styles: Record<string, React.CSSProperties> = {
  page: {
    background: "#0a0a0a",
    minHeight: "100vh",
    padding: "32px 24px",
    color: "#e0e0e0",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: 700,
    color: "#fff",
    margin: 0,
  },
  button: {
    background: "#4fc3f7",
    color: "#0a0a0a",
    border: "none",
    borderRadius: 6,
    padding: "10px 20px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  buttonDisabled: {
    background: "#333",
    color: "#888",
    border: "none",
    borderRadius: 6,
    padding: "10px 20px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "not-allowed",
  },
  summaryCard: {
    background: "#141414",
    border: "1px solid #222",
    borderRadius: 10,
    padding: "20px 28px",
    marginBottom: 28,
    display: "flex",
    gap: 32,
    alignItems: "center",
  },
  summaryBadge: {
    fontSize: 16,
    fontWeight: 600,
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
  },
  section: {
    marginBottom: 28,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 600,
    color: "#fff",
    marginBottom: 12,
  },
  card: {
    background: "#141414",
    border: "1px solid #222",
    borderRadius: 8,
    overflow: "hidden",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "12px 20px",
    borderBottom: "1px solid #1a1a1a",
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
    fontSize: 13,
    lineHeight: 1.5,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flexShrink: 0,
  },
  loading: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 64,
    color: "#888",
    fontSize: 15,
  },
};

const Doctor: React.FC = () => {
  const [data, setData] = React.useState<DoctorResponse | null>(null);
  const [loading, setLoading] = React.useState(true);

  const fetchAudit = React.useCallback(() => {
    setLoading(true);
    fetch("/api/doctor")
      .then((r) => r.json())
      .then((d: DoctorResponse) => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    fetchAudit();
  }, [fetchAudit]);

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.title}>Security Audit</h1>
        <button
          style={loading ? styles.buttonDisabled : styles.button}
          disabled={loading}
          onClick={fetchAudit}
        >
          Re-run Audit
        </button>
      </div>

      {loading && (
        <div style={styles.loading}>Running audit...</div>
      )}

      {!loading && data && (
        <>
          {/* Summary */}
          <div style={styles.summaryCard}>
            <span style={{ ...styles.summaryBadge, color: "#4caf50" }}>
              {data.total.passed} passed
            </span>
            <span style={{ ...styles.summaryBadge, color: "#ff9800" }}>
              {data.total.warnings} warnings/info
            </span>
          </div>

          {/* Passed */}
          {data.ok.length > 0 && (
            <div style={styles.section}>
              <div style={styles.sectionTitle}>Passed</div>
              <div style={styles.card}>
                {data.ok.map((line, i) => {
                  const parsed = parseLine(line);
                  return (
                    <div
                      key={i}
                      style={{
                        ...styles.row,
                        ...(i === data.ok.length - 1
                          ? { borderBottom: "none" }
                          : {}),
                      }}
                    >
                      <span
                        style={{ ...styles.dot, background: dotColor.ok }}
                      />
                      <span>{parsed.text}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Issues */}
          {data.issues.length > 0 && (
            <div style={styles.section}>
              <div style={styles.sectionTitle}>Issues</div>
              <div style={styles.card}>
                {data.issues.map((line, i) => {
                  const parsed = parseLine(line);
                  return (
                    <div
                      key={i}
                      style={{
                        ...styles.row,
                        ...(i === data.issues.length - 1
                          ? { borderBottom: "none" }
                          : {}),
                      }}
                    >
                      <span
                        style={{
                          ...styles.dot,
                          background: dotColor[parsed.severity],
                        }}
                      />
                      <span>{parsed.text}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      {!loading && !data && (
        <div style={styles.loading}>
          Failed to fetch audit data. Click Re-run Audit to try again.
        </div>
      )}
    </div>
  );
};

export default Doctor;
