import { useCallback, useEffect, useState } from "react";
import type { NowPlaying } from "../../lib/schedule.ts";
import { LookSwitch } from "./LookSwitch.tsx";
import { Drawer, DrawerPanel, type DrawerTab } from "./Drawer.tsx";
import { OwnerPanel, SignInLink, useOwner } from "./OwnerPanel.tsx";
import { Player } from "./Player.tsx";
import { RequestBox } from "./RequestBox.tsx";
import { RequestSettings } from "./RequestSettings.tsx";
import { RequestFeed } from "./RequestFeed.tsx";
import { type Action, useOwnerRequests } from "./useOwnerRequests.ts";
import { type PostedRequest, requestActive, useRequests } from "./useRequests.ts";
import { shouldPoll } from "./timing.ts";
import { useStation } from "./useStation.ts";
import { useWash } from "./useWash.ts";
import { Visualizer } from "./Visualizer.tsx";

/** Longer titles get smaller type so the whole title always fits the window. */
function titleSize(title: string) {
  if (title.length <= 22) return "xl";
  if (title.length <= 44) return "l";
  if (title.length <= 80) return "m";
  return "s";
}

function Title({ playing }: { playing: NowPlaying }) {
  const title = playing.current!.title;
  return (
    <div className="titles">
      <p className="label">Now playing</p>
      <h1 data-testid="now-title" className={`title-${titleSize(title)}`}>{title}</h1>
    </div>
  );
}

function UpNext({ playing, requestsOpen }: { playing: NowPlaying; requestsOpen: boolean }) {
  return (
    <p className="up-next">
      <span className="label">Up next</span>
      <b data-testid="next-title">{playing.next?.title ?? "Shuffling the library"}</b>
      {requestsOpen && <span className="request-line">Anyone can request a song.</span>}
    </p>
  );
}

const HINT_KEY = "ttunes.requestHintSeen";
function readFlag() {
  try {
    return localStorage.getItem(HINT_KEY) === "1";
  } catch {
    return false; // storage blocked: the hint still works for this visit
  }
}

/** First-visit tip: gone for good once closed or once the drawer has been opened. */
function useHintDismissed(drawerOpen: boolean): [boolean, () => void] {
  const [gone, setGone] = useState(readFlag);
  const dismiss = useCallback(() => {
    setGone(true);
    try {
      localStorage.setItem(HINT_KEY, "1");
    } catch {
      /* nothing to do: not remembered */
    }
  }, []);
  useEffect(() => {
    if (drawerOpen) dismiss();
  }, [drawerOpen, dismiss]);
  return [gone, dismiss];
}

function Message({ title, body, action }: { title: string; body: string; action?: { label: string; run: () => void } }) {
  return (
    <section className="message" role={action ? "alert" : "status"}>
      <h1>{title}</h1>
      <p>{body}</p>
      {action && (
        <button type="button" className="btn" onClick={action.run}>
          {action.label}
        </button>
      )}
    </section>
  );
}

export function App() {
  const [started, setStarted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("requests");
  const toggleDrawer = useCallback(() => setDrawerOpen((open) => !open), []);
  const ownerState = useOwner();
  const owner = ownerState === "owner";
  const [waitingOnRequest, setWaitingOnRequest] = useState(false); // mirrors `mine`, which needs the station's view first
  const { view, serverTime, retry, show } = useStation(shouldPoll({ started, paused, owner, requestActive: waitingOnRequest }));
  const playingNow = view.status === "ready" ? view.playing : null;
  const { feed, mine, afterPost, reloadFeed } = useRequests(playingNow);
  useEffect(() => setWaitingOnRequest(requestActive(mine)), [mine]);
  const [hintGone, dismissHint] = useHintDismissed(drawerOpen);
  const wash = useWash(playingNow?.current?.videoId);
  const ownerRequests = useOwnerRequests(owner, playingNow);
  const moderation = { note: ownerRequests.note, kept: ownerRequests.kept, busyId: ownerRequests.busyId, onAct: (id: number, action: Action) => void ownerRequests.moderate(id, action) };

  // The public feed is CDN-cached, so the owner's own box follows the owner's uncached mode.
  const modeFeed = owner ? ownerRequests.feed : feed;
  const boxMode = modeFeed.status === "ready" ? modeFeed.mode : null;
  const posted = async (post?: PostedRequest) => {
    await afterPost(post);
    if (owner) await ownerRequests.reload();
  };

  let body;
  if (view.status === "loading") body = <Message title="Tuning in" body="Finding out what's on air." />;
  else if (view.status === "error")
    body = <Message title="Can't reach the station" body="The schedule didn't load. Check your connection." action={{ label: "Try again", run: () => void retry() }} />;
  else if (!view.playing.current) body = <Message title="Off air" body="Nothing is in the library yet. Check back soon." action={{ label: "Check again", run: () => void retry() }} />;
  else
    body = (
      <>
        <Title playing={view.playing} />
        <div className="foot">
          <Visualizer active={started}>
            {started ? <Player playing={view.playing} serverTime={serverTime} onPausedChange={setPaused} /> : <div className="player-frame idle"><div className="player-host" /></div>}
          </Visualizer>
          {!started && (
            <button type="button" className="btn play" onClick={() => setStarted(true)}>
              <span aria-hidden="true" className="play-icon" />
              Play
            </button>
          )}
          <UpNext playing={view.playing} requestsOpen={boxMode !== "off"} />
        </div>
      </>
    );

  const washStyle = { "--wash-hot": wash.hot, "--wash-mid": wash.mid, "--wash-deep": wash.deep } as React.CSSProperties;
  return (
    <div className={`shell${drawerOpen ? " drawer-open" : ""}`} style={washStyle}>
      <header>
        <span className="wordmark">TTunes</span>
        <span className="on-air">
          <i aria-hidden="true" /> Live
        </span>
        <LookSwitch />
        {owner && <SignInLink owner />}
      </header>
      <main>{body}</main>
      <Drawer label={boxMode === "off" ? "Requests" : "Request a song"} open={drawerOpen} owner={owner} tab={drawerTab} onTab={setDrawerTab} onToggle={toggleDrawer}>
        <DrawerPanel id="requests" tab={owner ? drawerTab : "requests"} owner={owner}>
          <div className="requests">
            {owner && <RequestSettings feed={ownerRequests.feed} onMode={(mode) => void ownerRequests.setMode(mode)} onReload={() => void ownerRequests.reload()} />}
            {boxMode !== "off" && <RequestBox mine={mine} mode={boxMode} onPosted={posted} />}
            {owner ? (
              <RequestFeed feed={ownerRequests.feed} retry={() => void ownerRequests.reload()} moderation={moderation} />
            ) : (
              <RequestFeed feed={feed} retry={() => void reloadFeed()} />
            )}
          </div>
        </DrawerPanel>
        {owner && <OwnerPanel playing={playingNow} onPlaying={(playing) => void show(playing)} requests={ownerRequests} tab={drawerTab} />}
      </Drawer>
      {ownerState === "listener" && playingNow?.current && !drawerOpen && boxMode !== "off" && !hintGone && (
        <div className="hint-bubble" role="region" aria-label="Tip">
          <p>Got a song? Request it here.</p>
          <button type="button" aria-label="Close tip" onClick={dismissHint}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
      )}
      <footer>{ownerState === "listener" && <SignInLink owner={false} />}</footer>
    </div>
  );
}
