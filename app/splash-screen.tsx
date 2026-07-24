"use client";

import { useEffect, useState } from "react";

export default function SplashScreen() {
  const [phase, setPhase] = useState<"in" | "hold" | "out" | "done">("in");

  useEffect(() => {
    const t1 = setTimeout(() => setPhase("hold"), 800);
    const t2 = setTimeout(() => setPhase("out"), 2200);
    const t3 = setTimeout(() => setPhase("done"), 2800);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, []);

  if (phase === "done") return null;

  return (
    <div className={`splash-overlay ${phase === "out" ? "splash-out" : ""}`}>
      {/* Scanning line */}
      <div className="splash-scan" />

      {/* Sphere */}
      <div className="splash-sphere-wrap">
        {/* Outer ring pulse */}
        <div className="splash-ring splash-ring-1" />
        <div className="splash-ring splash-ring-2" />
        <img
          src="/icon-512x512.png"
          alt=""
          className="splash-icon"
          draggable={false}
        />
      </div>

      {/* Text */}
      <p className="splash-title">Slack Tracker</p>
      <p className="splash-sub">Operation AMZ</p>

      {/* Bottom dots loader */}
      <div className="splash-dots">
        <span /><span /><span />
      </div>
    </div>
  );
}
