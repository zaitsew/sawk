import { useState } from "react";
import type { FeedItem } from "../types";
import { timeLabel } from "../lib/days";
import { formatPrice } from "../lib/price";
import { FACES } from "../lib/store";

interface Props {
  item: FeedItem;
  fallbackTz: string;
  currency: string;
  past?: boolean;
  /** Past and planned: ask how it went. */
  askRating?: boolean;
  onSave: () => void;
  onGoing: () => void;
  onHide: () => void;
  onRate: (rating: number) => void;
  onSkip: () => void;
}

export function Card({ item, fallbackTz, currency, past, askRating, onSave, onGoing, onHide, onRate, onSkip }: Props) {
  const e = item.event;
  const [imgOk, setImgOk] = useState(true);
  const price = formatPrice(e, currency);
  const where = [e.venue, e.city].filter(Boolean).join(" · ");
  const saved = item.state === "saved";
  const going = item.state === "going";
  const label = `${e.title}, ${timeLabel(e, fallbackTz)}`;

  return (
    <article className="card" aria-label={label} data-state={item.state}>
      <div className="card-main">
        <div className="card-body">
          <p className="meta">
            <span className="time">{timeLabel(e, fallbackTz)}</span>
            <span className="chip chip-cat">{e.category}</span>
            {e.cancelled && <span className="chip chip-warn">Cancelled</span>}
          </p>
          <h3 className="card-title">{e.title}</h3>
          <p className="caption">
            {where}
            {price && <> <span aria-hidden="true">·</span> <span className="price">{price}</span></>}
          </p>
        </div>
        {e.imageUrl && imgOk && (
          <div className="thumb">
            <img src={e.imageUrl} alt="" loading="lazy" decoding="async" width={88} height={88} onError={() => setImgOk(false)} />
          </div>
        )}
      </div>

      <p className="reason">{item.reason}</p>

      {askRating ? (
        <div className="rate" role="group" aria-label="How was it?">
          <p className="rate-q">How was it?</p>
          <div className="faces">
            {FACES.map((f) => (
              <button key={f.rating} type="button" className="face" aria-label={f.label} title={f.label} onClick={() => onRate(f.rating)}>
                <span aria-hidden="true">{f.face}</span>
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-quiet" onClick={onSkip}>Didn't go</button>
        </div>
      ) : (
        <div className="actions">
          <button type="button" className="btn" aria-pressed={saved} onClick={onSave}>{saved ? "Saved" : "Save"}</button>
          {!past && <button type="button" className="btn" aria-pressed={going} onClick={onGoing}>Going</button>}
          <button type="button" className="btn btn-quiet" onClick={onHide}>Hide</button>
          <a className="btn btn-quiet" href={e.ticketUrl || e.url} target="_blank" rel="noopener noreferrer" aria-label={`Open link for ${e.title}`}>Open</a>
        </div>
      )}
    </article>
  );
}
