// The 1200x630 card: laptop screen left, phone screen right, one caption. The screens are real screenshots of the app.
export function frameHtml({ laptopPng, phonePng, feedPng }) {
  return `<!doctype html><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0}
  body{width:1200px;height:630px;background:#0b0b14;color:#fff;font-family:-apple-system,"Segoe UI",system-ui,sans-serif;position:relative;overflow:hidden}
  .laptop{position:absolute;left:36px;top:30px;width:520px;height:405px;border-radius:12px;overflow:hidden;border:2px solid #3a3a55;background:#000}
  .laptop img{width:516px;display:block}
  .feed{position:absolute;left:200px;top:385px;width:460px;border-radius:14px;overflow:hidden;box-shadow:0 12px 40px #000c}
  .feed img{width:460px;display:block}
  .phone{position:absolute;left:830px;top:30px;width:300px;height:440px;border-radius:30px;overflow:hidden;border:6px solid #3a3a55;background:#000}
  .phone img{width:288px;display:block}
  .cap{position:absolute;left:0;right:0;bottom:0;height:90px;display:flex;align-items:center;justify-content:center;font-size:40px;font-weight:800;letter-spacing:-.5px;color:#ffe14d;background:#0b0b14}
  </style>
  <div class="laptop"><img alt="" src="file://${laptopPng}"></div>
  <div class="feed"><img alt="" src="file://${feedPng}"></div>
  <div class="phone"><img alt="" src="file://${phonePng}"></div>
  <div class="cap">Same song, same second, for everyone.</div>`;
}
