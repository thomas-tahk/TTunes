// The 1200x630 card: laptop screen, request feed, phone screen, one caption. The screens are real screenshots of the app.
export function frameHtml({ laptopPng, phonePng, feedPng, laptopTime, phoneTime }) {
  return `<!doctype html><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0}
  body{width:1200px;height:630px;background:#0b0b14;color:#fff;font-family:-apple-system,"Segoe UI",system-ui,sans-serif;overflow:hidden}
  .row{position:absolute;left:30px;right:30px;top:24px;height:486px;display:flex;align-items:center;justify-content:space-between}
  .col{display:flex;flex-direction:column;align-items:center;gap:12px}
  .screen{overflow:hidden;background:#000;border:2px solid #3a3a55;border-radius:12px}
  .screen.phone{border-radius:26px;border-width:5px}
  .screen img,.feed img{display:block;width:100%}
  .feed{width:330px;border-radius:14px;overflow:hidden;box-shadow:0 10px 36px #000c}
  .chip{font-size:24px;font-weight:800;color:#0b0b14;background:#4dffe0;border-radius:999px;padding:4px 16px;font-variant-numeric:tabular-nums}
  .cap{position:absolute;left:0;right:0;bottom:0;height:96px;display:flex;align-items:center;justify-content:center;font-size:42px;font-weight:800;letter-spacing:-.5px;color:#ffe14d}
  </style>
  <div class="row">
   <div class="col"><div class="screen" style="width:430px"><img alt="" src="file://${laptopPng}"></div><span class="chip">laptop &middot; ${laptopTime}</span></div>
   <div class="feed"><img alt="" src="file://${feedPng}"></div>
   <div class="col"><div class="screen phone" style="width:260px"><img alt="" src="file://${phonePng}"></div><span class="chip">phone &middot; ${phoneTime}</span></div>
  </div>
  <div class="cap">Same song, same second, for everyone.</div>`;
}
