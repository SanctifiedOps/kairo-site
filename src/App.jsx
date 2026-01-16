import {useEffect,useMemo,useRef,useState} from "react";
import "./App.css";

const STANCES = ["ALIGN","REJECT","WITHHOLD"];

const nowUtc = () => {
  const d = new Date();
  return d.toISOString().replace("T"," ").replace("Z"," UTC");
};

const formatCountdown = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2,"0");
  const seconds = String(total % 60).padStart(2,"0");
  return `${minutes}:${seconds}`;
};

const formatWallet = (addr) => {
  if(!addr) return "CONNECT WALLET";
  return `${addr.slice(0,4)}...${addr.slice(-4)}`;
};

const getProvider = () => {
  if(window.solana?.isPhantom) return window.solana;
  if(window.solflare?.isSolflare) return window.solflare;
  if(window.solana?.isSolflare) return window.solana;
  return null;
};

const LOADING_LINES = [
  "Transmission initialized...",
  "Decoding KAIRO...",
  "Translating message...",
  "Transmission identified."
];
const GLITCH_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#@$%&*<>/+=";

export default function App() {
  const [transmission,setTransmission] = useState(null);
  const [stance,setStance] = useState(null);
  const [cycleLocked,setCycleLocked] = useState(false);
  const [hasVoted,setHasVoted] = useState(false);
  const [counts,setCounts] = useState({ALIGN:0,REJECT:0,WITHHOLD:0});
  const [countdown,setCountdown] = useState("05:00");
  const [status,setStatus] = useState("ROUTE: DEGRADED");
  const [glitch,setGlitch] = useState(false);
  const [utc,setUtc] = useState(nowUtc());
  const [audioOn,setAudioOn] = useState(false);
  const [wallet,setWallet] = useState(null);
  const [walletProvider,setWalletProvider] = useState(null);
  const [loadingLines,setLoadingLines] = useState([]);
  const [typedTransmission,setTypedTransmission] = useState("");
  const [showConsensus,setShowConsensus] = useState(true);
  const [pulseStances,setPulseStances] = useState(false);
  const audioRef = useRef(null);
  const buttonSoundRef = useRef(null);
  const timersRef = useRef([]);
  const lastGlitchRef = useRef(0);
  const lastAtRef = useRef(null);
  const lastPulseAtRef = useRef(null);
  const audioAllowKey = "kairoAudioAllowed";
  const voteKey = "kairoVoteCycle";

  const tagline = "EVERYTHING YOU SEE IS RESIDUAL";
  const caValue = "CA: PENDING";
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
      if(j){
        setTransmission(j);
        setCounts(j?.stanceCounts || {ALIGN:0,REJECT:0,WITHHOLD:0});
        setCycleLocked(Boolean(j?.locked));
      }
    }catch(err){
      // keep silent; status can degrade
      setStatus("ROUTE: DEGRADED");
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

  const consensusText = transmission?.consensus || transmission?.primary || "NO TRANSMISSION AVAILABLE";
  const finalChars = useMemo(() => {
    return (consensusText || "").split("").map((char) => ({
      char,
      delay:`${(Math.random() * 1.8).toFixed(2)}s`,
      duration:`${(1.2 + Math.random() * 2.4).toFixed(2)}s`,
      flip:`${(Math.random() * 6 - 3).toFixed(1)}deg`,
      hue:`${(Math.random() * 12 - 6).toFixed(1)}deg`
    }));
  },[consensusText]);

  useEffect(() => {
    let cancelled = false;
    const clearTimers = () => {
      timersRef.current.forEach((id) => {
        window.clearTimeout(id);
        window.clearInterval(id);
      });
      timersRef.current = [];
    };
    const delay = (ms) => new Promise((resolve) => {
      const id = window.setTimeout(resolve, ms);
      timersRef.current.push(id);
    });
    const typeTransmission = async (text) => {
      const chars = [];
      for(let i = 0; i < text.length; i += 1){
        if(cancelled) return;
        const current = text[i];
        if(current === "\n"){
          chars.push("\n");
          setTypedTransmission(chars.join(""));
          await delay(30);
          continue;
        }
        const wrong = GLITCH_CHARS[Math.floor(Math.random() * GLITCH_CHARS.length)];
        chars.push(wrong);
        setTypedTransmission(chars.join(""));
        await delay(10 + Math.floor(Math.random() * 20));
        chars[chars.length - 1] = current;
        setTypedTransmission(chars.join(""));
        await delay(10 + Math.floor(Math.random() * 25));
      }
    };

    clearTimers();
    setLoadingLines([]);
    setTypedTransmission("");
    setShowConsensus(false);
    if(!transmission?.at || !consensusText) return () => {clearTimers();};

    const run = async () => {
      for(const line of LOADING_LINES){
        setLoadingLines((prev) => [...prev, line]);
        await delay(420 + Math.floor(Math.random() * 360));
        if(cancelled) return;
      }
      await delay(240);
      await typeTransmission(consensusText);
      if(cancelled) return;
      setShowConsensus(true);
    };

    run();
    return () => {
      cancelled = true;
      clearTimers();
    };
  },[transmission?.at, consensusText]);

  useEffect(() => {
    if(!showConsensus || !transmission?.at) return;
    if(lastPulseAtRef.current === transmission.at) return;
    lastPulseAtRef.current = transmission.at;
    if(cycleLocked || hasVoted) return;
    setPulseStances(true);
    const id = window.setTimeout(() => {setPulseStances(false);},900);
    return () => {window.clearTimeout(id);};
  },[showConsensus, transmission?.at, cycleLocked, hasVoted]);

  useEffect(() => {
    if(!transmission?.at) return;
    if(transmission.at === lastAtRef.current) return;
    lastAtRef.current = transmission.at;
    if(transmission?.cycleId){
      const stored = window.localStorage.getItem(voteKey);
      setHasVoted(stored === transmission.cycleId);
    }else{
      setHasVoted(false);
    }
    setStance(null);
    setStatus("ROUTE: DEGRADED");
  },[transmission]);

  useEffect(() => {
    if(!transmission?.cycleEndsAt){
      setCountdown("05:00");
      return;
    }
    const tick = () => {
      const ms = Date.parse(transmission.cycleEndsAt) - Date.now();
      setCountdown(formatCountdown(ms));
    };
    tick();
    const t = window.setInterval(() => {tick();},1000);
    return () => {window.clearInterval(t);};
  },[transmission?.cycleEndsAt]);

  useEffect(() => {
    // occasional ambient glitch
    const t = window.setInterval(() => {
      const chance = Math.random();
      if(chance < 0.18) triggerGlitch();
    },12000);
    return () => {window.clearInterval(t);};
  },[]);

  useEffect(() => {
    const provider = getProvider();
    if(!provider) return;
    setWalletProvider(provider);
    if(provider.isConnected && provider.publicKey){
      setWallet(provider.publicKey.toString());
    }
    const onConnect = (pub) => {
      const key = pub?.toString?.() || provider.publicKey?.toString?.();
      if(key) setWallet(key);
    };
    const onDisconnect = () => {setWallet(null);};
    if(provider.on){
      provider.on("connect", onConnect);
      provider.on("disconnect", onDisconnect);
    }
    return () => {
      if(provider.off){
        provider.off("connect", onConnect);
        provider.off("disconnect", onDisconnect);
      }
    };
  },[]);

  useEffect(() => {
    const sound = buttonSoundRef.current;
    if(!sound) return;
    sound.volume = 0.15;
  },[]);

  useEffect(() => {
    const audio = audioRef.current;
    if(!audio) return;
    audio.volume = 0.08;
    const syncState = () => {
      setAudioOn(!audio.paused && !audio.muted);
    };
    const tryPlay = (forceUnmute) => {
      const allowed = window.localStorage.getItem(audioAllowKey) === "1";
      audio.muted = !(allowed || forceUnmute);
      audio.play().then(() => {
        if(!audio.muted) window.localStorage.setItem(audioAllowKey, "1");
        syncState();
      }).catch(() => {setAudioOn(false);});
    };
    const onGesture = () => {
      window.localStorage.setItem(audioAllowKey, "1");
      tryPlay(true);
    };
    const onCanPlay = () => {tryPlay(false);};
    audio.addEventListener("play", syncState);
    audio.addEventListener("pause", syncState);
    audio.addEventListener("volumechange", syncState);
    audio.addEventListener("canplay", onCanPlay);
    document.addEventListener("pointerdown", onGesture, {once:true});
    document.addEventListener("keydown", onGesture, {once:true});
    tryPlay(false);
    return () => {
      audio.removeEventListener("play", syncState);
      audio.removeEventListener("pause", syncState);
      audio.removeEventListener("volumechange", syncState);
      audio.removeEventListener("canplay", onCanPlay);
      document.removeEventListener("pointerdown", onGesture);
      document.removeEventListener("keydown", onGesture);
    };
  },[]);

  const submitStance = async (next) => {
    if(cycleLocked){
      setStatus("CYCLE CLOSED");
      return;
    }
    if(hasVoted){
      setStatus("INPUT LOCKED");
      return;
    }
    if(!wallet){
      setStatus("WALLET REQUIRED");
      return;
    }

    const provider = walletProvider || getProvider();
    if(!provider){
      setStatus("WALLET NOT FOUND");
      return;
    }

    setStatus("SIGNING...");

    try{
      const cycleId = transmission?.cycleId;
      const endsAt = transmission?.cycleEndsAt || "";
      const message = `KAIRO VOTE\ncycleId: ${cycleId}\nstance: ${next}\nexpires: ${endsAt}`;
      const messageBytes = new TextEncoder().encode(message);

      let signatureBytes;
      try{
        const signed = await provider.signMessage(messageBytes, "utf8");
        signatureBytes = signed.signature;
      }catch(signErr){
        setStatus("SIGNATURE DENIED");
        return;
      }

      const bs58Encode = (bytes) => {
        const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        const digits = [0];
        for(let i = 0; i < bytes.length; i += 1){
          let carry = bytes[i];
          for(let j = 0; j < digits.length; j += 1){
            carry += digits[j] << 8;
            digits[j] = carry % 58;
            carry = (carry / 58) | 0;
          }
          while(carry > 0){
            digits.push(carry % 58);
            carry = (carry / 58) | 0;
          }
        }
        for(let i = 0; i < bytes.length && bytes[i] === 0; i += 1) digits.push(0);
        return digits.reverse().map(d => ALPHABET[d]).join('');
      };
      const signature = bs58Encode(signatureBytes);

      setStance(next);
      setStatus("OBSERVATION RECORDED");
      triggerGlitch();

      const r = await fetch("/api/stance",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          stance:next,
          wallet,
          message,
          signature,
          at:new Date().toISOString()
        })
      });
      const j = await r.json();
      if(!r.ok){
        setStance(null);
        if(j?.error === "ALREADY_VOTED"){
          setHasVoted(true);
          setStatus("INPUT LOCKED");
          if(j?.stanceCounts) setCounts(j.stanceCounts);
          if(j?.cycleId) window.localStorage.setItem(voteKey, j.cycleId);
          return;
        }
        if(j?.error === "LOCKED" || j?.error === "CYCLE_EXPIRED"){
          setStatus("CYCLE CLOSED");
          setCycleLocked(true);
          return;
        }
        if(j?.error === "WALLET_REQUIRED" || j?.error === "SIGNATURE_REQUIRED"){
          setStatus("WALLET REQUIRED");
          return;
        }
        if(j?.error === "INVALID_SIGNATURE" || j?.error === "INVALID_MESSAGE"){
          setStatus("SIGNATURE INVALID");
          return;
        }
        if(j?.error === "RATE_LIMIT"){
          setStatus("RATE LIMIT EXCEEDED");
          return;
        }
        setStatus("ERROR: " + (j?.error || "UNKNOWN"));
        return;
      }
      setHasVoted(true);
      if(j?.stanceCounts) setCounts(j.stanceCounts);
      if(j?.cycleId) window.localStorage.setItem(voteKey, j.cycleId);
      setStatus("RECORDED");
    }catch(err){
      setStance(null);
      setStatus("ERROR: NETWORK");
    }
  };

  const toggleAudio = async () => {
    const audio = audioRef.current;
    if(!audio) return;
    if(audio.paused || audio.muted){
      try{
        audio.muted = false;
        await audio.play();
        window.localStorage.setItem(audioAllowKey, "1");
      }catch(err){
        setAudioOn(false);
      }
      return;
    }
    audio.pause();
  };

  const connectWallet = async () => {
    const provider = walletProvider || getProvider();
    if(!provider){
      setStatus("WALLET NOT FOUND");
      return;
    }
    try{
      const res = await provider.connect();
      const key = res?.publicKey?.toString?.() || provider.publicKey?.toString?.();
      if(key){
        setWallet(key);
        setStatus("WALLET CONNECTED");
      }
    }catch(err){
      setStatus("WALLET DENIED");
    }
  };

  const disconnectWallet = async () => {
    const provider = walletProvider || getProvider();
    if(provider?.disconnect){
      try{
        await provider.disconnect();
      }catch(err){
        // ignore
      }
    }
    setWallet(null);
    setStatus("WALLET DISCONNECTED");
  };

  const canVote = Boolean(wallet) && !hasVoted && !cycleLocked;
  const showCounts = hasVoted;

  const playButtonSound = () => {
    const sound = buttonSoundRef.current;
    if(!sound) return;
    sound.currentTime = 0;
    sound.play().catch(() => {});
  };

  const statusLine = cycleLocked
    ? "CYCLE CLOSED"
    : !wallet
      ? "WALLET REQUIRED"
      : hasVoted
        ? "INPUT LOCKED FOR CURRENT CYCLE"
        : "AWAITING OBSERVATION";

  const footerNote = utc;

  const copyCA = async () => {
    try{
      if(navigator.clipboard?.writeText){
        await navigator.clipboard.writeText(caValue);
        setStatus("CA COPIED");
        return;
      }
    }catch(err){
      // fall through
    }
    setStatus("CA COPY FAILED");
  };

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
      <audio ref={audioRef} autoPlay loop preload="auto" muted aria-hidden="true">
        <source src="/assets/kairo-sound.wav" type="audio/wav"/>
      </audio>
      <audio ref={buttonSoundRef} preload="auto" aria-hidden="true">
        <source src="/assets/kairo-button-sound.wav" type="audio/wav"/>
      </audio>
      <header className="headerBar">
        <div className="brand">
          <div className="brandName">KAIRO</div>
          <div className="brandTag">{tagline}</div>
        </div>
        <div className="meta">
          <button
            type="button"
            className="walletButton"
            onClick={() => {playButtonSound(); wallet ? disconnectWallet() : connectWallet();}}
            aria-label={wallet ? "Disconnect wallet" : "Connect wallet"}
          >
            {formatWallet(wallet)}
          </button>
        </div>
      </header>
      <main className="shell">
        <section className={"panel "+(glitch ? "glitch" : "")}> 
          <div className="panelTop">
            <div className="panelLabel">TRANSMISSION - CYCLE {transmission?.cycleIndex || 0}</div>
            <div className="panelCountdown">{countdown}</div>
          </div>

          {loadingLines.length ? (
            <div className="signalLog">
              {loadingLines.map((line, idx) => (
                <div key={`${line}-${idx}`} className="signalLogLine">{line}</div>
              ))}
            </div>
          ) : null}

          {!showConsensus ? (
            <div className="finalLoading">
              <div className="finalLoadingLabel">DECIPHERING FINAL TRANSMISSION</div>
              <div className="finalLoadingBar" aria-hidden="true"/>
            </div>
          ) : null}

          <div className={`txPrimary ${showConsensus ? "final" : "pending"}`}>
            {showConsensus ? (
              <span className="signalText">
                {finalChars.map((item, idx) => (
                  item.char === "\n"
                    ? <br key={`br-${idx}`}/>
                    : (
                      <span
                        key={`ch-${idx}`}
                        className="signalChar"
                        style={{
                          "--pulse-delay": item.delay,
                          "--pulse-duration": item.duration,
                          "--flip": item.flip,
                          "--hue": item.hue
                        }}
                      >
                        {item.char}
                      </span>
                    )
                ))}
              </span>
            ) : (
              <span className={`signalTyping ${typedTransmission ? "active" : ""}`}>{typedTransmission}</span>
            )}
          </div>

          <div className="stanceRow">
            {STANCES.map((s) => (
              <button
                key={s}
                type="button"
                className={`stance ${stance===s ? "active" : ""}${pulseStances ? " pulse" : ""}`}
                onClick={() => {playButtonSound(); submitStance(s);}}
                disabled={!canVote}
                aria-label={"Stance "+s}
              >
                <span className="stanceLabel">{s}</span>
                <span className="stanceCount">{showCounts ? (counts?.[s] ?? 0) : "--"}</span>
              </button>
            ))}
          </div>

          <div className="statusLine">{statusLine}</div>
        </section>
      </main>


      <footer className="footer">
        <div className="footLeft">
          <div className="footTime">{footerNote}</div>
        </div>
        <div className="footCenter">
          <button
            type="button"
            className="audioToggle"
            onClick={() => {playButtonSound(); toggleAudio();}}
            aria-label={audioOn ? "Pause audio" : "Play audio"}
          >
            {audioOn ? "PAUSE" : "PLAY"}
          </button>
        </div>
        <div className="footRight">
          <button
            type="button"
            className="copyButton"
            onClick={() => {playButtonSound(); copyCA();}}
            aria-label="Copy contract address"
          >
            COPY CA
          </button>
        </div>
      </footer>
    </div>
  );
}

