'use client';

import Script from 'next/script';
import { PointerEvent, useCallback, useEffect, useRef, useState } from 'react';

const MAX_SCORE = 5;
const CONNECT_RADIUS = 40;
const MIN_DOT_DISTANCE = 0.2;
const PATH_SAMPLE_DISTANCE = 5;
const SMOOTHING = 0.5;

const COLORS = {
  p1: '#00fff2',
  p2: '#ff00de',
  start: '#ff0033',
  finish: '#00ff33',
  crash: '#ffaa00',
};

type PlayerKey = 'p1' | 'p2';
type GameState = 'MENU' | 'PLAYING' | 'ROUND_END';
type SoundType = 'connect' | 'win' | 'start' | 'crash';

type Point = {
  x: number;
  y: number;
};

type TargetPoint = Point & {
  active: boolean;
};

type Player = {
  currentIdx: number;
  score: number;
  color: string;
  finished: boolean;
  handPos: Point;
  targetPos: TargetPoint;
  path: Point[];
  isDrawing: boolean;
};

type HandsResult = {
  multiHandLandmarks?: Array<Array<{ x: number; y: number }>>;
};

type HandsInstance = {
  setOptions(options: {
    maxNumHands: number;
    modelComplexity: number;
    minDetectionConfidence: number;
    minTrackingConfidence: number;
  }): void;
  onResults(callback: (results: HandsResult) => void): void;
  send(input: { image: HTMLVideoElement }): Promise<void>;
  close?: () => Promise<void>;
};

type CameraInstance = {
  start(): Promise<void>;
  stop?: () => void;
};

declare global {
  interface Window {
    Hands?: new (config: { locateFile: (file: string) => string }) => HandsInstance;
    Camera?: new (
      videoElement: HTMLVideoElement,
      config: { onFrame: () => Promise<void>; width: number; height: number },
    ) => CameraInstance;
    webkitAudioContext?: typeof AudioContext;
  }
}

const createPlayers = (): Record<PlayerKey, Player> => ({
  p1: {
    currentIdx: 0,
    score: 0,
    color: COLORS.p1,
    finished: false,
    handPos: { x: 0, y: 0 },
    targetPos: { x: 0, y: 0, active: false },
    path: [],
    isDrawing: false,
  },
  p2: {
    currentIdx: 0,
    score: 0,
    color: COLORS.p2,
    finished: false,
    handPos: { x: 0, y: 0 },
    targetPos: { x: 0, y: 0, active: false },
    path: [],
    isDrawing: false,
  },
});

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

const lerp = (start: number, end: number, amount: number) =>
  (1 - amount) * start + amount * end;

const generateLevel = (dotCount: number) => {
  const dots: Point[] = [];

  for (let index = 0; index < dotCount; index++) {
    let attempts = 0;
    let candidate: Point = { x: 0.5, y: 0.5 };
    let valid = false;

    while (!valid && attempts < 50) {
      candidate = {
        x: 0.15 + Math.random() * 0.7,
        y: 0.2 + Math.random() * 0.6,
      };
      valid = dots.every((dot) => distance(candidate, dot) >= MIN_DOT_DISTANCE);
      attempts++;
    }

    dots.push(candidate);
  }

  return dots;
};

const getIntersection = (p1: Point, p2: Point, p3: Point, p4: Point) => {
  const d =
    (p2.x - p1.x) * (p4.y - p3.y) -
    (p2.y - p1.y) * (p4.x - p3.x);

  if (d === 0) return false;

  const u =
    ((p3.x - p1.x) * (p4.y - p3.y) -
      (p3.y - p1.y) * (p4.x - p3.x)) /
    d;
  const v =
    ((p3.x - p1.x) * (p2.y - p1.y) -
      (p3.y - p1.y) * (p2.x - p1.x)) /
    d;

  return u > 0 && u < 1 && v > 0 && v < 1;
};

const checkSelfCollision = (path: Point[]) => {
  if (path.length < 4) return false;

  const latestStart = path[path.length - 2];
  const latestEnd = path[path.length - 1];

  for (let index = 0; index < path.length - 3; index++) {
    if (getIntersection(latestStart, latestEnd, path[index], path[index + 1])) {
      return true;
    }
  }

  return false;
};

export default function CyberConnect() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playersRef = useRef(createPlayers());
  const gameStateRef = useRef<GameState>('MENU');
  const roundDataRef = useRef<Point[]>([]);
  const levelRef = useRef(1);
  const animationRef = useRef<number | null>(null);
  const handsRef = useRef<HandsInstance | null>(null);
  const cameraRef = useRef<CameraInstance | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const manualModeRef = useRef(false);

  const [scriptsReady, setScriptsReady] = useState({ hands: false, camera: false });
  const [scriptsFailed, setScriptsFailed] = useState(false);
  const [cameraStatus, setCameraStatus] = useState('Kamera belum aktif');
  const [cameraReady, setCameraReady] = useState(false);
  const [menuVisible, setMenuVisible] = useState(true);
  const [level, setLevel] = useState(1);
  const [scores, setScores] = useState({ p1: 0, p2: 0 });
  const [notice, setNotice] = useState('');
  const [noticeColor, setNoticeColor] = useState('#ffffff');
  const [crash, setCrash] = useState<PlayerKey | null>(null);
  const [manualMode, setManualMode] = useState(false);

  const scriptsLoaded = scriptsReady.hands && scriptsReady.camera;

  const getDotPos = useCallback((playerKey: PlayerKey, normalizedDot: Point) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };

    const areaWidth = canvas.width / 2;
    const x =
      playerKey === 'p2'
        ? normalizedDot.x * areaWidth
        : canvas.width / 2 + normalizedDot.x * areaWidth;

    return { x, y: normalizedDot.y * canvas.height };
  }, []);

  const playSound = useCallback((type: SoundType, playerKey: PlayerKey = 'p1') => {
    const audio = audioRef.current;
    if (!audio) return;

    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.connect(gain);
    gain.connect(audio.destination);

    const now = audio.currentTime;

    if (type === 'connect') {
      oscillator.frequency.setValueAtTime(
        400 + playersRef.current[playerKey].currentIdx * 100,
        now,
      );
      oscillator.type = 'sine';
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
      oscillator.start(now);
      oscillator.stop(now + 0.1);
      return;
    }

    if (type === 'win') {
      oscillator.frequency.setValueAtTime(600, now);
      oscillator.frequency.linearRampToValueAtTime(1200, now + 0.3);
      oscillator.type = 'triangle';
      gain.gain.setValueAtTime(0.5, now);
      gain.gain.linearRampToValueAtTime(0, now + 1);
      oscillator.start(now);
      oscillator.stop(now + 1);
      return;
    }

    if (type === 'start') {
      oscillator.frequency.setValueAtTime(800, now);
      oscillator.type = 'sine';
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
      oscillator.start(now);
      oscillator.stop(now + 0.15);
      return;
    }

    oscillator.frequency.setValueAtTime(150, now);
    oscillator.frequency.linearRampToValueAtTime(50, now + 0.3);
    oscillator.type = 'sawtooth';
    gain.gain.setValueAtTime(0.5, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
    oscillator.start(now);
    oscillator.stop(now + 0.3);
  }, []);

  const resetRoundPlayers = useCallback(() => {
    (['p1', 'p2'] as PlayerKey[]).forEach((key) => {
      const player = playersRef.current[key];
      player.currentIdx = 0;
      player.finished = false;
      player.path = [];
      player.isDrawing = false;
      player.handPos = { x: 0, y: 0 };
      player.targetPos = { ...player.targetPos, active: player.targetPos.active };
    });
  }, []);

  const startNextRound = useCallback(() => {
    resetRoundPlayers();
    setLevel(levelRef.current);
    roundDataRef.current = generateLevel(levelRef.current + 2);
    gameStateRef.current = 'PLAYING';
  }, [resetRoundPlayers]);

  const resetToMenu = useCallback(() => {
    gameStateRef.current = 'MENU';
    setMenuVisible(true);
    setNotice('');
    setCameraStatus(cameraReady ? 'Kamera aktif. Klik MULAI GAME.' : cameraStatus);
  }, [cameraReady, cameraStatus]);

  const handleRoundWin = useCallback(
    (winnerKey: PlayerKey) => {
      const winner = playersRef.current[winnerKey];
      const winnerName = winnerKey === 'p1' ? 'PLAYER 1' : 'PLAYER 2';

      gameStateRef.current = 'ROUND_END';
      playSound('win', winnerKey);
      winner.score++;
      setScores({ p1: playersRef.current.p1.score, p2: playersRef.current.p2.score });

      if (winner.score >= MAX_SCORE) {
        setNotice(`${winnerName} WINS THE MATCH! PERFECT SCORE: ${winner.score}`);
        setNoticeColor(winner.color);

        window.setTimeout(() => {
          resetToMenu();
        }, 5000);
        return;
      }

      setNotice(`${winnerName} WINS LEVEL ${levelRef.current}!`);
      setNoticeColor(winner.color);

      window.setTimeout(() => {
        setNotice('');
        levelRef.current++;
        startNextRound();
      }, 3000);
    },
    [playSound, resetToMenu, startNextRound],
  );

  const triggerCrash = useCallback(
    (playerKey: PlayerKey) => {
      const player = playersRef.current[playerKey];
      playSound('crash', playerKey);
      player.currentIdx = 0;
      player.isDrawing = false;
      player.path = [];

      setCrash(playerKey);
      window.setTimeout(() => setCrash(null), 800);
    },
    [playSound],
  );

  function updatePlayerPos(player: Player) {
    if (!player.targetPos.active) return;

    if (player.handPos.x === 0 && player.handPos.y === 0) {
      player.handPos.x = player.targetPos.x;
      player.handPos.y = player.targetPos.y;
      return;
    }

    player.handPos.x = lerp(player.handPos.x, player.targetPos.x, SMOOTHING);
    player.handPos.y = lerp(player.handPos.y, player.targetPos.y, SMOOTHING);
  }

  function handlePlayerLogic(playerKey: PlayerKey) {
    const player = playersRef.current[playerKey];
    updatePlayerPos(player);

    if (!player.targetPos.active || player.finished || gameStateRef.current !== 'PLAYING') {
      return;
    }

    const hand = player.handPos;

    if (player.currentIdx === 0) {
      const startDot = getDotPos(playerKey, roundDataRef.current[0]);
      if (distance(hand, startDot) < CONNECT_RADIUS) {
        player.currentIdx = 1;
        player.isDrawing = true;
        player.path = [{ x: hand.x, y: hand.y }];
        playSound('start', playerKey);
      }
      return;
    }

    if (!player.isDrawing) return;

    const lastPoint = player.path[player.path.length - 1];
    if (distance(hand, lastPoint) > PATH_SAMPLE_DISTANCE) {
      player.path.push({ x: hand.x, y: hand.y });

      if (checkSelfCollision(player.path)) {
        triggerCrash(playerKey);
        return;
      }
    }

    const targetDot = roundDataRef.current[player.currentIdx];
    const targetPos = getDotPos(playerKey, targetDot);

    if (distance(hand, targetPos) < CONNECT_RADIUS) {
      player.currentIdx++;

      if (player.currentIdx >= roundDataRef.current.length) {
        player.finished = true;
        player.isDrawing = false;
        handleRoundWin(playerKey);
      } else {
        playSound('connect', playerKey);
      }
    }
  }

  function drawCenterLine(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) {
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.shadowBlur = 5;
    ctx.shadowColor = '#000000';
    ctx.setLineDash([10, 15]);
    ctx.beginPath();
    ctx.moveTo(canvas.width / 2, 0);
    ctx.lineTo(canvas.width / 2, canvas.height);
    ctx.stroke();
    ctx.restore();
  }

  function drawPath(ctx: CanvasRenderingContext2D, player: Player) {
    if (player.path.length === 0) return;

    ctx.save();
    ctx.beginPath();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = 10;
    ctx.strokeStyle = player.color;
    ctx.shadowBlur = 20;
    ctx.shadowColor = player.color;
    ctx.moveTo(player.path[0].x, player.path[0].y);

    for (let index = 1; index < player.path.length; index++) {
      ctx.lineTo(player.path[index].x, player.path[index].y);
    }

    if (player.isDrawing && player.targetPos.active) {
      ctx.lineTo(player.handPos.x, player.handPos.y);
    }

    ctx.stroke();
    ctx.restore();
  }

  function drawDots(ctx: CanvasRenderingContext2D, playerKey: PlayerKey) {
    const player = playersRef.current[playerKey];

    roundDataRef.current.forEach((dot, index) => {
      const pos = getDotPos(playerKey, dot);
      const isPassed = index < player.currentIdx;
      const isNext = index === player.currentIdx;

      let color = '#444444';
      let radius = 15;
      let label = String(index + 1);

      if (index === 0) {
        color = COLORS.start;
        if (isNext) label = 'START';
      }

      if (index === roundDataRef.current.length - 1) {
        color = COLORS.finish;
        label = 'FINISH';
      }

      ctx.save();
      ctx.beginPath();

      if (isPassed) {
        ctx.fillStyle = player.color;
        ctx.shadowBlur = 10;
        ctx.shadowColor = player.color;
      } else if (isNext) {
        ctx.fillStyle = index === 0 ? COLORS.start : '#ffffff';
        radius = 25 + Math.sin(Date.now() / 100) * 5;
        ctx.shadowBlur = 30;
        ctx.shadowColor = '#ffffff';
      } else {
        ctx.fillStyle = color;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
      }

      ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
      ctx.fill();
      if (!isPassed && !isNext) ctx.stroke();

      ctx.fillStyle = isPassed || isNext ? '#000000' : '#ffffff';
      ctx.font = label.length > 2 ? 'bold 12px Orbitron, monospace' : 'bold 16px Orbitron, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#000000';
      ctx.strokeText(label, pos.x, pos.y);
      ctx.fillText(label, pos.x, pos.y);
      ctx.restore();
    });
  }

  function drawCrosshair(ctx: CanvasRenderingContext2D, player: Player) {
    if (!player.targetPos.active) return;

    ctx.save();
    ctx.strokeStyle = player.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(player.handPos.x, player.handPos.y, 20, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(player.handPos.x, player.handPos.y, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(player.handPos.x - 10, player.handPos.y);
    ctx.lineTo(player.handPos.x + 10, player.handPos.y);
    ctx.moveTo(player.handPos.x, player.handPos.y - 10);
    ctx.lineTo(player.handPos.x, player.handPos.y + 10);
    ctx.stroke();
    ctx.restore();
  }

  const ensureLoop = useCallback(() => {
    if (animationRef.current !== null) return;

    const drawFrame = () => {
      const canvas = canvasRef.current;
      const video = videoRef.current;
      const ctx = canvas?.getContext('2d');

      if (!canvas || !video || !ctx) {
        animationRef.current = requestAnimationFrame(drawFrame);
        return;
      }

      handlePlayerLogic('p1');
      handlePlayerLogic('p2');

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#020617';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      if (video.readyState >= 2 && !manualModeRef.current) {
        ctx.save();
        ctx.scale(-1, 1);
        ctx.translate(-canvas.width, 0);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        ctx.restore();
      } else {
        const gradient = ctx.createRadialGradient(
          canvas.width / 2,
          canvas.height * 0.15,
          0,
          canvas.width / 2,
          canvas.height / 2,
          canvas.width,
        );
        gradient.addColorStop(0, '#101b35');
        gradient.addColorStop(0.55, '#050816');
        gradient.addColorStop(1, '#000000');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      drawCenterLine(ctx, canvas);

      if (gameStateRef.current === 'PLAYING' || gameStateRef.current === 'ROUND_END') {
        (['p1', 'p2'] as PlayerKey[]).forEach((key) => {
          drawPath(ctx, playersRef.current[key]);
          drawDots(ctx, key);
        });
      }

      (['p1', 'p2'] as PlayerKey[]).forEach((key) => {
        drawCrosshair(ctx, playersRef.current[key]);
      });

      animationRef.current = requestAnimationFrame(drawFrame);
    };

    animationRef.current = requestAnimationFrame(drawFrame);
    // The animation loop reads mutable refs on every frame and must be started only once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
  }, []);

  const initHands = useCallback(() => {
    if (handsRef.current || !window.Hands) return handsRef.current;

    const hands = new window.Hands({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
    });

    hands.setOptions({
      maxNumHands: 2,
      modelComplexity: 1,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

    hands.onResults((results) => {
      let p1Found = false;
      let p2Found = false;
      const canvas = canvasRef.current;
      if (!canvas || manualModeRef.current) return;

      results.multiHandLandmarks?.forEach((landmarks) => {
        const indexFinger = landmarks[8];
        if (!indexFinger) return;

        const x = (1 - indexFinger.x) * canvas.width;
        const y = indexFinger.y * canvas.height;

        if (x > canvas.width / 2) {
          playersRef.current.p1.targetPos = { x, y, active: true };
          p1Found = true;
        } else {
          playersRef.current.p2.targetPos = { x, y, active: true };
          p2Found = true;
        }
      });

      if (!p1Found) playersRef.current.p1.targetPos.active = false;
      if (!p2Found) playersRef.current.p2.targetPos.active = false;
    });

    handsRef.current = hands;
    return hands;
  }, []);

  const initCamera = useCallback(async () => {
    const video = videoRef.current;

    if (scriptsFailed) {
      setCameraStatus('MediaPipe gagal dimuat dari CDN. Pakai MODE MANUAL atau cek koneksi internet.');
      return;
    }

    if (!scriptsLoaded || !video || !window.Camera || !window.Hands) {
      setCameraStatus('Library kamera masih dimuat...');
      return;
    }

    setCameraStatus('Menyalakan kamera...');

    try {
      if (!audioRef.current) {
        const BrowserAudioContext = window.AudioContext || window.webkitAudioContext;
        audioRef.current = new BrowserAudioContext();
      }

      const hands = initHands();
      if (!hands) throw new Error('MediaPipe Hands tidak tersedia');

      cameraRef.current = new window.Camera(video, {
        onFrame: async () => {
          if (document.visibilityState === 'visible') {
            await hands.send({ image: video });
          }
        },
        width: 1280,
        height: 720,
      });

      await cameraRef.current.start();
      manualModeRef.current = false;
      setManualMode(false);
      setCameraReady(true);
      setCameraStatus('Kamera aktif. Klik MULAI GAME.');
      ensureLoop();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'izin kamera ditolak';
      setCameraStatus(`Kamera gagal aktif: ${message}. Pakai mode manual.`);
      manualModeRef.current = true;
      setManualMode(true);
      setCameraReady(true);
      ensureLoop();
    }
  }, [ensureLoop, initHands, scriptsFailed, scriptsLoaded]);

  const enableManualMode = useCallback(() => {
    if (!audioRef.current) {
      const BrowserAudioContext = window.AudioContext || window.webkitAudioContext;
      audioRef.current = new BrowserAudioContext();
    }

    manualModeRef.current = true;
    setManualMode(true);
    setCameraReady(true);
    setCameraStatus('Mode manual aktif. Gerakkan pointer di sisi kiri/kanan.');
    ensureLoop();
  }, [ensureLoop]);

  const startGame = useCallback(() => {
    playersRef.current = createPlayers();
    levelRef.current = 1;
    setScores({ p1: 0, p2: 0 });
    setLevel(1);
    setNotice('');
    setMenuVisible(false);
    startNextRound();
    ensureLoop();
  }, [ensureLoop, startNextRound]);

  const handlePointerMove = useCallback((event: PointerEvent<HTMLCanvasElement>) => {
    if (!manualModeRef.current) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const playerKey: PlayerKey = x > rect.width / 2 ? 'p1' : 'p2';
    playersRef.current[playerKey].targetPos = { x, y, active: true };
  }, []);

  const handlePointerLeave = useCallback(() => {
    if (!manualModeRef.current) return;
    playersRef.current.p1.targetPos.active = false;
    playersRef.current.p2.targetPos.active = false;
  }, []);

  useEffect(() => {
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    return () => {
      window.removeEventListener('resize', resizeCanvas);
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
      cameraRef.current?.stop?.();
      void handsRef.current?.close?.();
    };
  }, [resizeCanvas]);

  return (
    <main className="cyber-connect">
      <Script
        src="https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js"
        strategy="afterInteractive"
        onLoad={() => setScriptsReady((ready) => ({ ...ready, hands: true }))}
        onError={() => {
          setScriptsFailed(true);
          setCameraStatus('MediaPipe gagal dimuat dari CDN. Pakai MODE MANUAL atau cek koneksi internet.');
        }}
      />
      <Script
        src="https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js"
        strategy="afterInteractive"
        onLoad={() => setScriptsReady((ready) => ({ ...ready, camera: true }))}
        onError={() => {
          setScriptsFailed(true);
          setCameraStatus('MediaPipe gagal dimuat dari CDN. Pakai MODE MANUAL atau cek koneksi internet.');
        }}
      />

      <video ref={videoRef} className="cyber-video" playsInline muted />
      <canvas
        ref={canvasRef}
        className="cyber-canvas"
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
      />

      <section className="cyber-hud" aria-label="Game status">
        <div className="cyber-score cyber-score-p2">
          <span>PLAYER 2</span>
          <strong>{scores.p2}</strong>
        </div>
        <div className={`cyber-level ${menuVisible ? 'is-hidden' : ''}`}>
          LEVEL {level}
        </div>
        <div className="cyber-score cyber-score-p1">
          <span>PLAYER 1</span>
          <strong>{scores.p1}</strong>
        </div>
      </section>

      {menuVisible && (
        <section className="cyber-menu" aria-label="Main menu">
          <h1>CYBER CONNECT</h1>
          <p>
            Hubungkan titik <b>1 ke 2 ke 3</b> tanpa putus. Jangan menabrak
            garis sendiri. Pemain pertama yang mencapai <b>5 poin</b> menang.
          </p>
          <div className="cyber-status">{cameraStatus}</div>
          <div className="cyber-actions">
            <button type="button" onClick={initCamera} disabled={!scriptsLoaded || scriptsFailed}>
              {scriptsFailed ? 'KAMERA CDN ERROR' : scriptsLoaded ? 'NYALAKAN KAMERA' : 'LOADING CAMERA'}
            </button>
            <button type="button" onClick={enableManualMode}>
              MODE MANUAL
            </button>
            <button type="button" onClick={startGame} disabled={!cameraReady}>
              MULAI GAME
            </button>
          </div>
          <p className="cyber-credit">Made by Jovanka Wilyam</p>
        </section>
      )}

      {notice && (
        <div className="cyber-notice" style={{ color: noticeColor }}>
          {notice}
        </div>
      )}

      {crash && (
        <div className={`cyber-crash cyber-crash-${crash}`}>
          CRASH!
        </div>
      )}

      {manualMode && !menuVisible && (
        <div className="cyber-manual-badge">MANUAL MODE</div>
      )}
    </main>
  );
}
