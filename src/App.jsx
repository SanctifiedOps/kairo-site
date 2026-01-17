import {useEffect,useMemo,useRef,useState} from "react";
import "./App.css";

const STANCES = ["ALIGN","REJECT","WITHHOLD"];

const nowUtc = () => {
  const d = new Date();
  return d.toISOString().replace("T"," ").replace("Z"," UTC");
};

const formatCountdown = (ms) => {
  const totalMs = Math.max(0, ms);
  const total = Math.floor(totalMs / 1000);
  const minutes = String(Math.floor(total / 60)).padStart(2,"0");
  const seconds = String(total % 60).padStart(2,"0");
  const milliseconds = String(Math.floor((totalMs % 1000) / 10)).padStart(2,"0");
  return `${minutes}:${seconds}.${milliseconds}`;
};

const getWinnerMessage = (option) => {
  const messages = {
    ALIGN: "Alignment proves fruitful",
    REJECT: "Rejection bears reward",
    WITHHOLD: "Withholding from action becomes action in itself"
  };
  return messages[option] || "";
};

const formatWallet = (addr) => {
  if(!addr) return "CONNECT WALLET";
  return `${addr.slice(0,4)}...${addr.slice(-4)}`;
};

const getProvider = () => {
  if(window.solana?.isPhantom){
    console.log("Phantom wallet detected");
    return window.solana;
  }
  if(window.solflare?.isSolflare){
    console.log("Solflare wallet detected");
    return window.solflare;
  }
  if(window.solana?.isSolflare){
    console.log("Solflare wallet detected (via solana object)");
    return window.solana;
  }
  console.log("No Solana wallet detected. window.solana:", window.solana, "window.solflare:", window.solflare);
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
  const [toasts,setToasts] = useState([]);
  const audioRef = useRef(null);
  const buttonSoundRef = useRef(null);
  const timersRef = useRef([]);
  const lastGlitchRef = useRef(0);
  const lastAtRef = useRef(null);
  const lastPulseAtRef = useRef(null);
  const lastWinnerCycleRef = useRef(null);
  const audioAllowKey = "kairoAudioAllowed";
  const voteKey = "kairoVoteCycle";

  const tagline = "EVERYTHING YOU SEE IS RESIDUAL";
  const caValue = "CA: PENDING";

  const showToast = (message, type = "info", duration = 4000, isWinner = false) => {
    const id = Date.now();
    const toast = {id, message, type, isWinner};
    setToasts(prev => [...prev, toast]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, duration);
  };

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
  const finalTokens = useMemo(() => {
    const tokens = [];
    let word = [];
    const pushWord = () => {
      if(word.length){
        tokens.push({type:"word", chars:word});
        word = [];
      }
    };
    const text = consensusText || "";
    for(let i = 0; i < text.length; i += 1){
      const char = text[i];
      if(char === "\n"){
        pushWord();
        tokens.push({type:"newline"});
        continue;
      }
      if(char === " "){
        pushWord();
        tokens.push({type:"space"});
        continue;
      }
      word.push({
        char,
        delay:`${(Math.random() * 1.8).toFixed(2)}s`,
        duration:`${(1.2 + Math.random() * 2.4).toFixed(2)}s`,
        flip:`${(Math.random() * 6 - 3).toFixed(1)}deg`,
        hue:`${(Math.random() * 12 - 6).toFixed(1)}deg`
      });
    }
    pushWord();
    return tokens;
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
      setCountdown("05:00.00");
      return;
    }
    const tick = () => {
      const ms = Date.parse(transmission.cycleEndsAt) - Date.now();
      setCountdown(formatCountdown(ms));
    };
    tick();
    const t = window.setInterval(() => {tick();},50);
    return () => {window.clearInterval(t);};
  },[transmission?.cycleEndsAt]);

  useEffect(() => {
    if(!transmission?.reward?.option) return;
    if(!transmission?.cycleId) return;
    if(lastWinnerCycleRef.current === transmission.cycleId) return;
    lastWinnerCycleRef.current = transmission.cycleId;
    const winnerMsg = getWinnerMessage(transmission.reward.option);
    if(winnerMsg){
      showToast(winnerMsg, "success", 10000, true);
    }
  },[transmission?.reward?.option, transmission?.cycleId]);

  useEffect(() => {
    // occasional ambient glitch
    const t = window.setInterval(() => {
      const chance = Math.random();
      if(chance < 0.18) triggerGlitch();
    },12000);
    return () => {window.clearInterval(t);};
  },[]);

  useEffect(() => {
    const setupWallet = () => {
      const provider = getProvider();
      if(!provider){
        console.log("No wallet provider found on initial check");
        return false;
      }
      setWalletProvider(provider);
      if(provider.isConnected && provider.publicKey){
        setWallet(provider.publicKey.toString());
        console.log("Wallet auto-connected:", provider.publicKey.toString());
      }
      const onConnect = (pub) => {
        const key = pub?.toString?.() || provider.publicKey?.toString?.();
        if(key){
          setWallet(key);
          console.log("Wallet connected via event:", key);
        }
      };
      const onDisconnect = () => {
        setWallet(null);
        console.log("Wallet disconnected");
      };
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
    };

    // Try immediately
    const cleanup = setupWallet();

    // If no provider found, retry after wallets load
    if(!cleanup){
      const timer = setTimeout(() => {
        console.log("Retrying wallet detection after delay...");
        setupWallet();
      }, 1000);
      return () => clearTimeout(timer);
    }

    return cleanup;
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
    if(!next || !["ALIGN","REJECT","WITHHOLD"].includes(next)){
      setStatus("INVALID INPUT");
      showToast("OBSERVATION PARAMETER CORRUPTED. SIGNAL REJECTED.", "error");
      return;
    }
    if(cycleLocked){
      setStatus("CYCLE CLOSED");
      showToast("CYCLE TERMINATED. SIGNAL WINDOW CLOSED.", "error");
      return;
    }
    if(hasVoted){
      setStatus("INPUT LOCKED");
      showToast("INPUT LOCKED: OBSERVATION ALREADY RECORDED.", "warning");
      return;
    }
    if(!wallet){
      setStatus("WALLET REQUIRED");
      showToast("ACTOR IDENTITY REQUIRED. SIGNAL SOURCE MISSING.", "warning");
      return;
    }

    const provider = walletProvider || getProvider();
    if(!provider){
      setStatus("WALLET NOT FOUND");
      showToast("SIGNAL INTERFACE OFFLINE. PROVIDER NOT DETECTED.", "error");
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
        showToast("AUTHENTICATION REJECTED. SIGNAL UNSIGNED.", "error");
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
          showToast("INPUT LOCKED: OBSERVATION ALREADY RECORDED.", "warning");
          return;
        }
        if(j?.error === "LOCKED" || j?.error === "CYCLE_EXPIRED"){
          setStatus("CYCLE CLOSED");
          setCycleLocked(true);
          showToast("CYCLE TERMINATED. NEXT TRANSMISSION PENDING.", "error");
          return;
        }
        if(j?.error === "NOT_ELIGIBLE"){
          setStatus("NOT ELIGIBLE");
          const minBalance = j?.minRequired || 100000;
          const currentBalance = j?.balance || 0;
          showToast(`CIRCUIT ACCESS DENIED. THRESHOLD: ${minBalance.toLocaleString()} $KAIRO. DETECTED: ${currentBalance.toLocaleString()}.`, "error");
          return;
        }
        if(j?.error === "WALLET_FLAGGED"){
          setStatus("WALLET FLAGGED");
          showToast("ACTOR FLAGGED: ANOMALY PATTERN DETECTED.", "error");
          return;
        }
        if(j?.error === "WALLET_REQUIRED" || j?.error === "SIGNATURE_REQUIRED"){
          setStatus("WALLET REQUIRED");
          showToast("AUTHENTICATION REQUIRED. SIGNAL SOURCE UNSIGNED.", "error");
          return;
        }
        if(j?.error === "INVALID_SIGNATURE" || j?.error === "INVALID_MESSAGE"){
          setStatus("SIGNATURE INVALID");
          showToast("SIGNAL INTEGRITY COMPROMISED. AUTHENTICATION FAILED.", "error");
          return;
        }
        if(j?.error === "RATE_LIMIT"){
          setStatus("RATE LIMIT EXCEEDED");
          const tier = j?.tier || "new";
          const limit = j?.limit || 3;
          showToast(`CONGESTION THRESHOLD EXCEEDED. TIER: ${tier.toUpperCase()}. CAPACITY: ${limit}/MIN.`, "error");
          return;
        }
        if(j?.error === "INVALID_STANCE"){
          setStatus("INVALID INPUT");
          showToast("OBSERVATION PARAMETER CORRUPTED. SIGNAL REJECTED.", "error");
          return;
        }
        setStatus("ERROR: " + (j?.error || "UNKNOWN"));
        showToast(`SYSTEM FAULT: ${j?.error || "UNKNOWN"}`, "error");
        return;
      }
      setHasVoted(true);
      setStance(next);
      if(j?.stanceCounts) setCounts(j.stanceCounts);
      if(j?.cycleId) window.localStorage.setItem(voteKey, j.cycleId);
      setStatus("RECORDED");
      showToast(`OBSERVATION LOGGED: ${next}`, "success");
    }catch(err){
      setStance(null);
      setStatus("ERROR: NETWORK");
      showToast("ROUTE DEGRADED. CONNECTION UNSTABLE.", "error");
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
      showToast("NO WALLET DETECTED. INSTALL PHANTOM OR SOLFLARE.", "error");
      console.log("No wallet provider available");
      return;
    }

    console.log("Attempting to connect to wallet...", {
      isPhantom: provider.isPhantom,
      isSolflare: provider.isSolflare,
      isConnected: provider.isConnected,
      hasPublicKey: !!provider.publicKey
    });

    setStatus("CONNECTING...");
    try{
      // Standard Phantom/Solflare connection - no parameters needed
      const resp = await provider.connect();
      console.log("Connect response:", resp);

      // Get public key from response or provider
      const publicKey = resp?.publicKey || provider.publicKey;
      if(!publicKey){
        throw new Error("No public key returned from wallet");
      }

      const walletAddress = publicKey.toString();
      console.log("Wallet connected successfully:", walletAddress);

      setWallet(walletAddress);
      setStatus("WALLET CONNECTED");
      showToast("WALLET CONNECTED", "success");
    }catch(err){
      console.error("Wallet connection failed:", err);

      // Handle specific error cases
      let errorMsg = "CONNECTION FAILED";

      if(err.code === 4001 || err.message?.toLowerCase().includes("user rejected")){
        errorMsg = "USER REJECTED CONNECTION";
      }else if(err.message?.toLowerCase().includes("already pending")){
        errorMsg = "CONNECTION ALREADY PENDING. CHECK WALLET POPUP.";
      }else if(err.message){
        errorMsg = `ERROR: ${err.message}`;
      }

      setStatus("CONNECTION FAILED");
      showToast(errorMsg, "error");
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
                {finalTokens.map((token, idx) => {
                  if(token.type === "newline") return <br key={`br-${idx}`}/>;
                  if(token.type === "space") return <span key={`sp-${idx}`} className="signalSpace"> </span>;
                  return (
                    <span key={`word-${idx}`} className="signalWord">
                      {token.chars.map((item, charIdx) => (
                        <span
                          key={`ch-${idx}-${charIdx}`}
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
                      ))}
                    </span>
                  );
                })}
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
            className="pillButton copyButton"
            onClick={() => {playButtonSound(); copyCA();}}
            aria-label="Copy contract address"
          >
            COPY CA
          </button>
          <a
            className="pillButton"
            href="https://t.me/kairoresidual"
            target="_blank"
            rel="noreferrer"
          >
            TELEGRAM
          </a>
          <a
            className="pillButton"
            href="https://x.com/kairoresidual"
            target="_blank"
            rel="noreferrer"
          >
            FOLLOW ON X
          </a>
        </div>
      </footer>

      <div className="toastContainer" aria-live="polite" aria-atomic="true">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.type}${toast.isWinner ? ' toast-winner' : ''}`}>
            <div className="toastMessage">{toast.message}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

