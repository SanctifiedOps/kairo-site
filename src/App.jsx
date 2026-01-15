import {useEffect,useMemo,useRef,useState} from "react";
import "./App.css";

const STANCES = ["ALIGN","REJECT","WITHHOLD"];

const nowUtc = () => {
  const d = new Date();
  return d.toISOString().replace("T"," ").replace("Z"," UTC");
};

export default function App() {
  const [transmission,setTransmission] = useState(null);
  const [stance,setStance] = useState(null);
  const [locked,setLocked] = useState(false);
  const [status,setStatus] = useState("ROUTE: DEGRADED");
  const [glitch,setGlitch] = useState(false);
  const [utc,setUtc] = useState(nowUtc());
  const lastGlitchRef = useRef(0);
  const lastAtRef = useRef(null);

  const tagline = "EVERYTHING YOU SEE IS RESIDUAL";
  const sigil = "\u2020>z\u0160\u00FA_";

  const integrity = useMemo(() => {
    if(!transmission?.integrity) return "LOW";
    return transmission.integrity;
  },[transmission]);

  const triggerGlitch = () => {
    const now = Date.now();
    if(now - lastGlitchRef.current < 1500) return;
    lastGlitchRef.current = now;
    setGlitch(true);
    window.setTimeout(() => {setGlitch(false);},220);
  };

  const fetchLast = async () => {
    try{
      const r = await fetch("/api/last");
      if(!r.ok) throw new Error("bad_status");
      const j = await r.json();
      if(j?.primary){
        setTransmission(j);
      }
    }catch(err){
      // keep silent; status can degrade
      setStatus("ROUTE: OFFLINE");
    }
  };

  useEffect(() => {
    fetchLast();
    const t = window.setInterval(() => {fetchLast();},8000);
    return () => {window.clearInterval(t);};
  },[]);

  useEffect(() => {
    const t = window.setInterval(() => {setUtc(nowUtc());},1000);
    return () => {window.clearInterval(t);};
  },[]);

  useEffect(() => {
    if(!transmission?.at) return;
    if(transmission.at === lastAtRef.current) return;
    lastAtRef.current = transmission.at;
    setLocked(false);
    setStance(null);
    setStatus("ROUTE: DEGRADED");
  },[transmission]);

  useEffect(() => {
    // occasional ambient glitch
    const t = window.setInterval(() => {
      const chance = Math.random();
      if(chance < 0.18) triggerGlitch();
    },12000);
    return () => {window.clearInterval(t);};
  },[]);

  const submitStance = async (next) => {
    if(locked) return;
    setStance(next);
    setLocked(true);
    setStatus("OBSERVATION RECORDED");
    triggerGlitch();

    try{
      const r = await fetch("/api/stance",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({stance:next,at:new Date().toISOString()})
      });
      if(!r.ok) throw new Error("bad_status");
      setStatus("RECORDED");
    }catch(err){
      // still keep the recorded feel, but degrade status subtly
      setStatus("RECORDED (DEGRADED)");
    }
  };

  const footerNote = status.includes("OFFLINE")
    ? "CONGESTION INCREASED"
    : locked
      ? "OBSERVATION RECORDED"
      : "NO RESPONSE REQUIRED";

  return (
    <div className="kairo">
      <video
        className="bgVideo"
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        aria-hidden="true"
      >
        <source src="/assets/kairo-bg.mp4" type="video/mp4"/>
        <source src="/assets/kairo.bg.mov" type="video/quicktime"/>
      </video>
      <header className="headerBar">
        <div className="brand">
          <div className="brandName">KAIRO</div>
          <div className="brandTag">{tagline}</div>
        </div>
        <div className="meta">
          <div className="utc">{utc}</div>
          <div className="route">{status}</div>
        </div>
      </header>

      <main className="shell">
        <section className={"panel "+(glitch ? "glitch" : "")}>
          <div className="panelTop">
            <div className="panelLabel">TRANSMISSION</div>
            <div className="integrity">INTEGRITY: {integrity}</div>
          </div>

          <div className="txPrimary">
            {transmission?.primary || "NO TRANSMISSION AVAILABLE"}
          </div>

          {transmission?.secondary ? (
            <div className="txSecondary">{transmission.secondary}</div>
          ) : null}

          <div className="stanceRow">
            {STANCES.map((s) => (
              <button
                key={s}
                type="button"
                className={"stance "+(stance===s ? "active" : "")}
                onClick={() => {submitStance(s);}}
                disabled={locked}
                aria-label={"Stance "+s}
              >
                {s}
              </button>
            ))}
          </div>

          <div className="statusLine">
            {locked ? "INPUT LOCKED FOR CURRENT CYCLE" : "AWAITING OBSERVATION"}
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="footLeft">{sigil}</div>
        <div className="footRight">{footerNote}</div>
      </footer>
    </div>
  );
}
