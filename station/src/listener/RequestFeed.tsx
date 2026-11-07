import { minutes } from "./ownerFetch.ts";
import type { FeedItem, FeedState, Mode, RequestStatus } from "./useRequests.ts";

const MODE_LABEL: Record<Mode, string> = { open: "Open", approve: "Approval on", off: "Requests off" };
const STATUS_LABEL: Record<RequestStatus, string> = {
  waiting: "Waiting for approval",
  queued: "Coming up",
  playing: "Playing now",
  played: "Played",
  expired: "Expired",
};

function Row({ item }: { item: FeedItem }) {
  return (
    <li className="feed-row" data-testid="feed-row">
      <img src={item.thumbnail} alt="" width={64} height={36} loading="lazy" />
      <div className="feed-body">
        <p className="feed-name">{item.name}</p>
        <p className="feed-title">{item.title} <span className="feed-len">{minutes(item.durationSec)}</span></p>
        {item.dedication && <p className="feed-dedication">{item.dedication}</p>}
      </div>
      <span className={`chip status-${item.status}`}>{STATUS_LABEL[item.status]}</span>
    </li>
  );
}

export function RequestFeed({ feed, retry }: { feed: FeedState; retry: () => void }) {
  return (
    <section className="feed" aria-labelledby="feed-h">
      <div className="feed-head">
        <h2 id="feed-h">Requests</h2>
        {feed.status === "ready" && <span className={`chip mode-${feed.mode}`} data-testid="mode-chip">{MODE_LABEL[feed.mode]}</span>}
      </div>
      {feed.status === "loading" && <p className="feed-note" role="status">Loading requests…</p>}
      {feed.status === "error" && (
        <div role="alert" className="feed-note">
          <p>The requests didn't load.</p>
          <button type="button" className="btn small ghost" onClick={retry}>Try again</button>
        </div>
      )}
      {feed.status === "ready" && feed.requests.length === 0 && <p className="feed-note">No requests yet. Be the first.</p>}
      {feed.status === "ready" && feed.requests.length > 0 && (
        <ul className="feed-list" data-testid="feed">
          {feed.requests.map((item) => <Row key={item.id} item={item} />)}
        </ul>
      )}
    </section>
  );
}
