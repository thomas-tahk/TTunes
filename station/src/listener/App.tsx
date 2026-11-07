import { useState } from "react";
import type { NowPlaying } from "../../lib/schedule.ts";
import { OwnerPanel, SignInLink, useOwner } from "./OwnerPanel.tsx";
import { Player } from "./Player.tsx";
import { RequestBox } from "./RequestBox.tsx";
import { RequestFeed } from "./RequestFeed.tsx";
import { type Action, useOwnerRequests } from "./useOwnerRequests.ts";
import { type PostedRequest, useRequests } from "./useRequests.ts";
import { useStation } from "./useStation.ts";
import { Visualizer } from "./Visualizer.tsx";

function Titles({ playing }: { playing: NowPlaying }) {
  return (
    <div className="titles">
      <p className="label">Now playing</p>
      <h1 data-testid="now-title">{playing.current!.title}</h1>
      <p className="up-next">
        <span className="label">Up next</span> <span data-testid="next-title">{playing.next?.title ?? "Shuffling the library"}</span>
      </p>
    </div>
  );
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
  const { view, serverTime, retry, show } = useStation();
  const [started, setStarted] = useState(false);
  const owner = useOwner();
  const playingNow = view.status === "ready" ? view.playing : null;
  const { feed, mine, afterPost, reloadFeed } = useRequests(playingNow);
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
  else if (!view.playing.current) body = <Message title="Off air" body="Nothing is in the library yet. Check back soon." />;
  else
    body = (
      <>
        <Visualizer active={started}>
          {started ? <Player playing={view.playing} serverTime={serverTime} /> : <div className="player-frame idle" />}
        </Visualizer>
        <Titles playing={view.playing} />
        {!started && (
          <button type="button" className="btn play" onClick={() => setStarted(true)}>
            <span aria-hidden="true" className="play-icon" />
            Play
          </button>
        )}
      </>
    );

  return (
    <div className="shell">
      <header>
        <span className="wordmark">TTunes</span>
        <span className="on-air">
          <i aria-hidden="true" /> Live
        </span>
        <SignInLink owner={owner} />
      </header>
      <main>{body}</main>
      <div className="requests">
        {boxMode !== "off" && <RequestBox mine={mine} mode={boxMode} onPosted={posted} />}
        {owner ? (
          <RequestFeed feed={ownerRequests.feed} retry={() => void ownerRequests.reload()} moderation={moderation} />
        ) : (
          <RequestFeed feed={feed} retry={() => void reloadFeed()} />
        )}
      </div>
      {owner && <OwnerPanel playing={playingNow} onPlaying={(playing) => void show(playing)} requests={ownerRequests} />}
    </div>
  );
}
