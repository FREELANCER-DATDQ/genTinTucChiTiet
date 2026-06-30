function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function limitWords(value, maxWords) {
  const words = String(value || "").replace(/\s+/g, " ").trim().split(/\s+/).filter(Boolean);
  return words.length <= maxWords ? words.join(" ") : `${words.slice(0, maxWords).join(" ")}...`;
}

function subtitleCueTexts(text, maxWords = 13) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/g) || [clean];
  const cues = [];
  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/).filter(Boolean);
    for (let index = 0; index < words.length; index += maxWords) {
      cues.push(words.slice(index, index + maxWords).join(" "));
    }
  }
  return cues.filter(Boolean);
}

function renderSubtitleCues(selection, scenes, narrationAudio, totalSeconds, outroSeconds) {
  const contentSeconds = scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0);
  const voiceDuration = Math.max(1, Math.min(narrationAudio?.durationSeconds || contentSeconds, contentSeconds - 0.5, totalSeconds - outroSeconds - 0.5));
  const cues = subtitleCueTexts(selection.voiceoverScript);
  const wordCounts = cues.map((cue) => cue.split(/\s+/).filter(Boolean).length);
  const totalWords = Math.max(1, wordCounts.reduce((sum, count) => sum + count, 0));
  let cursor = 0.25;
  return cues.map((cue, index) => {
    const share = wordCounts[index] / totalWords;
    const remaining = Math.max(0.15, 0.25 + voiceDuration - cursor);
    const duration = index === cues.length - 1 ? remaining : Math.max(1.35, share * voiceDuration);
    const html = `<div id="subtitle-${String(index + 1).padStart(2, "0")}" class="clip subtitle-cue" data-start="${cursor.toFixed(3)}" data-duration="${duration.toFixed(3)}" data-track-index="${30 + (index % 3)}">${escapeHtml(cue)}</div>`;
    cursor += duration;
    return html;
  }).join("\n");
}

function renderListItems(items = []) {
  return items.map((item, index) => `<div class="visual-item">
    <span class="item-index">${String(index + 1).padStart(2, "0")}</span>
    <span class="item-copy">${escapeHtml(item)}</span>
  </div>`).join("");
}

function renderBarChart(scene) {
  const maximum = Math.max(1, ...scene.chartData.map((item) => item.value));
  return `<div class="bar-chart">${scene.chartData.map((item) => {
    const width = Math.max(4, Math.min(100, item.value / maximum * 100));
    return `<div class="bar-row visual-item">
      <div class="bar-meta"><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.displayValue)}</strong></div>
      <div class="bar-track"><div class="bar-fill" style="width:${width.toFixed(2)}%"></div></div>
    </div>`;
  }).join("")}</div>`;
}

export function renderSceneVisual(scene, index = 0) {
  const primary = scene.visualPrimary || scene.headline;
  const secondary = scene.visualSecondary || scene.body;
  let content = "";
  if (scene.visualType === "bar-chart") {
    content = renderBarChart(scene);
  } else if (scene.visualType === "stat-card") {
    content = `<div class="stat-wrap">
      <div class="visual-primary stat-value">${escapeHtml(primary)}</div>
      <div class="visual-secondary stat-label">${escapeHtml(secondary)}</div>
      <div class="graphic-rule"></div>
    </div>${renderListItems(scene.visualItems)}`;
  } else if (scene.visualType === "comparison") {
    content = `<div class="comparison">${scene.visualItems.slice(0, 2).map((item, itemIndex) => `<div class="comparison-card visual-item">
      <span>${itemIndex === 0 ? "TRƯỚC" : "SAU"}</span>
      <strong>${escapeHtml(item)}</strong>
    </div>`).join("")}</div>`;
  } else if (scene.visualType === "timeline" || scene.visualType === "process") {
    content = `<div class="sequence ${scene.visualType}">${renderListItems(scene.visualItems)}</div>`;
  } else if (scene.visualType === "kinetic-headline") {
    content = `<div class="kinetic-wrap">
      <div class="visual-primary kinetic-primary">${escapeHtml(primary)}</div>
      <div class="visual-secondary kinetic-secondary">${escapeHtml(secondary)}</div>
      <div class="graphic-rule"></div>
    </div>`;
  } else {
    content = `<div class="key-points">${renderListItems(scene.visualItems)}</div>`;
  }
  return `<section id="scene-${String(scene.index).padStart(2, "0")}" class="scene visual-${escapeHtml(scene.visualType)}${index === 0 ? " scene-first" : ""}" data-layout-allow-overlap>
    <div class="scene-grid" data-layout-ignore></div>
    <div class="scene-orb" data-layout-ignore></div>
    <div class="scene-content">
      <div class="scene-label">${escapeHtml(scene.label)}</div>
      <h2 class="visual-title">${escapeHtml(scene.visualTitle || scene.headline)}</h2>
      <div class="visual-body">${content}</div>
    </div>
  </section>`;
}

export function renderHotStoryComposition({
  selection,
  scenes,
  totalSeconds,
  narrationAudio,
  publicDate,
  width,
  height,
  fps,
  outroSeconds,
  transitionSeconds,
  watermark,
  backgroundVolume,
  narrationVolume
}) {
  const sceneHtml = scenes.map(renderSceneVisual).join("\n");
  const audioHtml = narrationAudio?.src
    ? `<audio id="story-narration" data-start="0.25" data-duration="${Math.max(0.1, Math.min(narrationAudio.durationSeconds || totalSeconds, totalSeconds - 0.35))}" data-track-index="20" data-volume="${narrationVolume}" src="${escapeHtml(narrationAudio.src)}"></audio>`
    : "";
  const outroStart = totalSeconds - outroSeconds;
  const publicTitle = limitWords(selection.videoTitle, 18);
  const timings = scenes.map((scene) => ({ start: scene.startSeconds, duration: scene.durationSeconds }));

  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(selection.videoTitle)}</title>
  <link rel="icon" href="data:," />
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: #08090c; font-family: Arial, "Helvetica Neue", sans-serif; }
    #stage { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; background: #08090c; }
    .channel-panel { position: absolute; left: 0; width: 100%; height: 640px; z-index: 5; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; padding: 54px 72px; overflow: hidden; }
    .channel-panel.top { top: 0; background: linear-gradient(180deg, #101217 0%, #0b0d10 100%); border-bottom: 14px solid #e30613; }
    .channel-panel.bottom { bottom: 0; background: linear-gradient(180deg, #0b0d10 0%, #101217 100%); border-top: 14px solid #e30613; gap: 26px; }
    .brand-kicker { margin: 0 0 22px; color: #fff46b; font-size: 34px; line-height: 1; font-weight: 950; text-transform: uppercase; }
    .brand-title { margin: 0; color: #fff9ef; font-size: 86px; line-height: .98; font-weight: 950; letter-spacing: -.035em; text-wrap: balance; text-shadow: 0 10px 34px rgba(0,0,0,.7); }
    .follow-pill { display: inline-flex; align-items: center; justify-content: center; min-height: 104px; margin-top: 38px; padding: 0 52px; background: #e30613; color: #fff9ef; font-size: 48px; font-weight: 950; box-shadow: 14px 14px 0 rgba(255,249,239,.9); }
    .channel-name { margin: 0; color: #fff9ef; font-size: 64px; line-height: 1; font-weight: 950; }
    .channel-meta { margin: 0; color: #fff46b; font-size: 31px; line-height: 1.2; font-weight: 900; max-width: 900px; text-wrap: balance; text-transform: uppercase; }
    .scene { position: absolute; left: 0; top: 640px; width: 100%; height: 640px; opacity: 0; overflow: hidden; background-color: #111318; z-index: 3; }
    .scene-first { opacity: 1; }
    .scene-grid { position: absolute; inset: 0; opacity: .18; background-image: linear-gradient(rgba(255,255,255,.16) 1px, rgba(255,255,255,0) 1px), linear-gradient(90deg, rgba(255,255,255,.16) 1px, rgba(255,255,255,0) 1px); background-size: 72px 72px; }
    .scene-orb { position: absolute; width: 430px; height: 430px; right: -110px; top: -170px; border-radius: 50%; background: radial-gradient(circle, rgba(227,6,19,.74) 0%, rgba(227,6,19,.12) 48%, rgba(227,6,19,0) 72%); }
    .scene-content { position: relative; width: 100%; height: 100%; padding: 44px 62px 142px; display: flex; flex-direction: column; gap: 20px; box-sizing: border-box; z-index: 2; }
    .scene-label { align-self: flex-start; padding: 10px 18px; background: #e30613; color: #fff9ef; font-size: 22px; line-height: 1; font-weight: 950; letter-spacing: .08em; }
    .visual-title { margin: 0; max-width: 900px; color: #fff9ef; font-size: 58px; line-height: 1.02; font-weight: 950; letter-spacing: -.035em; text-wrap: balance; }
    .visual-body { flex: 1; min-height: 0; display: flex; flex-direction: column; justify-content: center; }
    .visual-primary { color: #fff46b; font-size: 88px; line-height: .94; font-weight: 950; letter-spacing: -.04em; font-variant-numeric: tabular-nums; text-wrap: balance; }
    .visual-secondary { margin-top: 16px; max-width: 850px; color: #f6eee5; font-family: Georgia, serif; font-size: 31px; line-height: 1.18; font-weight: 400; text-wrap: balance; }
    .graphic-rule { width: 260px; height: 12px; margin-top: 24px; background: #e30613; transform-origin: left center; }
    .stat-value { font-size: 112px; }
    .key-points, .sequence { display: flex; flex-direction: column; gap: 12px; }
    .key-points .visual-item, .sequence .visual-item { display: grid; grid-template-columns: 62px 1fr; align-items: center; gap: 16px; min-height: 58px; padding: 10px 18px; background: #1d2026; border-bottom: 4px solid #e30613; }
    .item-index { color: #fff46b; font-size: 23px; font-weight: 950; font-variant-numeric: tabular-nums; }
    .item-copy { color: #fff9ef; font-size: 26px; line-height: 1.08; font-weight: 850; }
    .sequence .visual-item { grid-template-columns: 54px 1fr; border-bottom-color: #fff46b; }
    .comparison { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; }
    .comparison-card { min-height: 250px; padding: 28px; display: flex; flex-direction: column; justify-content: space-between; background: #1d2026; border: 4px solid #343840; }
    .comparison-card:last-child { background: #e30613; border-color: #e30613; }
    .comparison-card span { color: #fff46b; font-size: 20px; font-weight: 950; letter-spacing: .12em; }
    .comparison-card:last-child span { color: #fff9ef; }
    .comparison-card strong { color: #fff9ef; font-size: 34px; line-height: 1.08; font-weight: 950; }
    .bar-chart { display: flex; flex-direction: column; gap: 16px; }
    .bar-meta { display: flex; justify-content: space-between; align-items: baseline; gap: 24px; color: #fff9ef; font-size: 24px; font-weight: 850; }
    .bar-meta strong { color: #fff46b; font-size: 30px; font-variant-numeric: tabular-nums; }
    .bar-track { height: 20px; margin-top: 6px; background: #30343c; overflow: hidden; }
    .bar-fill { height: 100%; background: #e30613; transform-origin: left center; }
    .subtitle-layer { position: absolute; left: 0; top: 640px; width: 100%; height: 640px; z-index: 8; pointer-events: none; overflow: hidden; }
    .subtitle-cue { position: absolute; left: 52px; right: 52px; bottom: 24px; min-height: 92px; padding: 16px 24px; opacity: 0; transform: translateY(12px); background: rgba(8,9,12,.9); color: #fff9ef; font-size: 38px; line-height: 1.08; font-weight: 950; text-align: center; text-wrap: balance; text-shadow: 0 4px 16px rgba(0,0,0,.85); }
    .outro { position: absolute; inset: 0; opacity: 0; overflow: hidden; z-index: 50; background: linear-gradient(135deg, #08090c 0%, #17191f 48%, #e30613 49%, #e30613 58%, #08090c 59%); }
    .outro::before { content: ""; position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,.2), rgba(0,0,0,.72)); }
    .outro-inner { position: absolute; inset: 0; padding: 170px 74px 190px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 38px; }
    .outro h2 { margin: 0; color: #fff9ef; font-size: 76px; line-height: 1.02; font-weight: 950; text-wrap: balance; text-shadow: 0 8px 34px rgba(0,0,0,.7); }
    .outro p { margin: 0; color: #fff46b; font-size: 40px; line-height: 1.18; font-weight: 900; max-width: 880px; text-shadow: 0 6px 26px rgba(0,0,0,.72); text-wrap: balance; }
    .pill { display: inline-flex; align-items: center; justify-content: center; min-width: 620px; min-height: 96px; padding: 0 44px; background: #fff9ef; color: #101217; font-size: 42px; font-weight: 950; box-shadow: 14px 14px 0 #e30613; }
    .watermark { position: absolute; right: 50px; bottom: 42px; z-index: 100; color: rgba(255,249,239,.88); font-size: 28px; font-weight: 900; text-shadow: 0 4px 22px rgba(0,0,0,.8); }
    .progress { position: absolute; left: 0; right: 0; bottom: 0; height: 16px; background: rgba(255,255,255,.18); z-index: 101; }
    .progress-inner { height: 100%; width: 100%; background: #e30613; transform-origin: left center; }
  </style>
</head>
<body>
  <div id="stage" data-composition-id="root" data-start="0" data-duration="${totalSeconds}" data-width="${width}" data-height="${height}">
    <section class="channel-panel top">
      <p class="brand-kicker">Tin mới mỗi ngày</p>
      <h1 class="brand-title">Theo dõi kênh để cập nhật nhanh tin tức nóng</h1>
      <div class="follow-pill">${escapeHtml(watermark)}</div>
    </section>
    ${sceneHtml}
    <div class="subtitle-layer">${renderSubtitleCues(selection, scenes, narrationAudio, totalSeconds, outroSeconds)}</div>
    <section class="channel-panel bottom">
      <p class="channel-name">${escapeHtml(watermark)}</p>
      <p class="channel-meta">Bản tin tóm tắt • ${escapeHtml(publicDate)} • ${escapeHtml(publicTitle)}</p>
    </section>
    <section id="outro-subscribe" class="outro">
      <div class="outro-inner">
        <h2>Theo dõi diễn biến tiếp theo</h2>
        <p>${escapeHtml(publicTitle)}</p>
        <div class="pill">${escapeHtml(watermark)}</div>
      </div>
    </section>
    <div class="watermark">${escapeHtml(watermark)}</div>
    <div class="progress"><div class="progress-inner"></div></div>
    <audio id="background-music" data-start="0" data-duration="${totalSeconds}" data-track-index="10" data-volume="${backgroundVolume}" src="assets/background01.mp3"></audio>
    ${audioHtml}
  </div>
  <script>
    window.__hfDuration = ${totalSeconds};
    window.__hfFps = ${fps};
    const timings = ${JSON.stringify(timings)};
    const scenes = [...document.querySelectorAll(".scene")];
    const subtitleCues = [...document.querySelectorAll(".subtitle-cue")].map((element) => ({
      element,
      start: Number(element.dataset.start || 0),
      duration: Number(element.dataset.duration || 0)
    }));
    const outro = document.querySelector(".outro");
    const subtitleLayer = document.querySelector(".subtitle-layer");
    const progress = document.querySelector(".progress-inner");
    const master = gsap.timeline({ paused: true });
    window.__timelines = window.__timelines || {};

    scenes.forEach((scene, index) => {
      const start = timings[index].start;
      if (index > 0) {
        master.fromTo(scene, { opacity: 0, x: 90 }, { opacity: 1, x: 0, duration: ${transitionSeconds}, ease: "power3.out" }, start);
        master.to(scenes[index - 1], { opacity: 0, x: -90, duration: ${transitionSeconds}, ease: "power3.in" }, start);
      }
      const grid = scene.querySelector(".scene-grid");
      const orb = scene.querySelector(".scene-orb");
      const label = scene.querySelector(".scene-label");
      const title = scene.querySelector(".visual-title");
      const primary = scene.querySelector(".visual-primary");
      const secondary = scene.querySelector(".visual-secondary");
      const items = scene.querySelectorAll(".visual-item");
      const rules = scene.querySelectorAll(".graphic-rule, .bar-fill");
      master.fromTo(grid, { opacity: 0 }, { opacity: .18, duration: .75, ease: "sine.out" }, start + .12);
      master.fromTo(orb, { opacity: 0, scale: .72 }, { opacity: 1, scale: 1, duration: .62, ease: "expo.out" }, start + .16);
      master.fromTo(label, { opacity: 0, x: -34 }, { opacity: 1, x: 0, duration: .38, ease: "power4.out" }, start + .18);
      master.fromTo(title, { opacity: 0, y: 34 }, { opacity: 1, y: 0, duration: .58, ease: "expo.out" }, start + .28);
      if (primary) master.fromTo(primary, { opacity: 0, scale: .88 }, { opacity: 1, scale: 1, duration: .64, ease: "back.out(1.25)" }, start + .42);
      if (secondary) master.fromTo(secondary, { opacity: 0, x: 30 }, { opacity: 1, x: 0, duration: .48, ease: "circ.out" }, start + .58);
      if (items.length) master.fromTo(items, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: .44, stagger: .075, ease: "power2.out" }, start + .48);
      if (rules.length) master.fromTo(rules, { scaleX: 0 }, { scaleX: 1, duration: .68, stagger: .06, ease: "power3.out" }, start + .62);
    });

    master.to(scenes[scenes.length - 1], { opacity: 0, scale: 1.06, duration: .45, ease: "power3.in" }, ${outroStart});
    master.to(subtitleLayer, { opacity: 0, duration: .14, ease: "power2.in" }, ${outroStart - 0.14});
    master.fromTo(outro, { opacity: 0 }, { opacity: 1, duration: .45, ease: "power2.out" }, ${outroStart});
    master.fromTo(outro.querySelector(".outro-inner").children, { y: 50, opacity: 0, scale: .94 }, { y: 0, opacity: 1, scale: 1, stagger: .11, duration: .52, ease: "back.out(1.45)" }, ${outroStart + 0.14});
    master.to(outro, { opacity: 0, duration: .22, ease: "power2.in" }, ${totalSeconds - 0.22});
    master.fromTo(progress, { scaleX: 0 }, { scaleX: 1, duration: ${totalSeconds}, ease: "none" }, 0);
    window.__timelines.root = master;

    function syncSubtitles(time) {
      subtitleCues.forEach(({ element, start, duration }) => {
        const local = time - start;
        const visible = local >= 0 && local <= duration;
        const fade = .14;
        const opacity = visible ? Math.max(0, Math.min(1, local / fade, (duration - local) / fade)) : 0;
        element.style.opacity = String(opacity);
        element.style.transform = "translateY(" + (12 * (1 - opacity)).toFixed(2) + "px)";
        element.style.visibility = visible ? "visible" : "hidden";
      });
    }

    function seek(value) {
      const time = Math.max(0, Math.min(${totalSeconds}, Number(value) || 0));
      master.time(time);
      syncSubtitles(time);
    }

    window.__hyperframes = { duration: ${totalSeconds}, fps: ${fps}, seek };
    window.addEventListener("hf-seek", (event) => seek(event.detail?.time ?? 0));
    seek(0);
  </script>
</body>
</html>`;
}
