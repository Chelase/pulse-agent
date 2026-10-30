(function () {
  "use strict";

  // 页面数据取自仓库契约：部署时由 workflow 复制到 data/；本地用仓库根目录起静态服务时回退到 ../common/
  var SOURCES = {
    gates: ["data/gate-conditions.json", "../common/models/gate-conditions.json"],
    caps: ["data/watch-capabilities.json", "../common/capabilities/watch-capabilities.json"]
  };

  // 契约里有条件，但代码还没有对应采样来源（见 event-gate-chain.md「未接通的数据源」）
  var RANGES = {
    heart_rate: { min: 30, max: 180, unit: "bpm", label: "心率" },
    on_body: { min: 0, max: 1, unit: "", label: "佩戴状态", names: ["未佩戴", "已佩戴"] }
  };
  var OPS = {
    gt: { sym: ">", test: function (v, t) { return v > t; } },
    lt: { sym: "<", test: function (v, t) { return v < t; } },
    eq: { sym: "=", test: function (v, t) { return v === t; } }
  };

  function $(id) { return document.getElementById(id); }

  function load(urls) {
    return urls.reduce(function (p, url) {
      return p.catch(function () {
        return fetch(url).then(function (r) {
          if (!r.ok) throw new Error(url + " " + r.status);
          return r.json();
        });
      });
    }, Promise.reject());
  }

  function fmtTime(s) {
    if (s <= 0) return "立即";
    if (s < 60) return s + " 秒";
    if (s % 60 === 0) return s / 60 + " 分钟";
    return Math.floor(s / 60) + " 分 " + (s % 60) + " 秒";
  }

  /* ---------- 闸门演示 ---------- */
  function initDemo(data) {
    var conds = (data.conditions || []).filter(function (c) { return RANGES[c.dataType] && OPS[c.operator]; });
    var sel = $("cond"), val = $("val"), dur = $("dur");
    if (!conds.length) { $("verdict").textContent = "闸门条件加载失败"; return; }

    conds.forEach(function (c, i) {
      var o = document.createElement("option");
      o.value = i;
      o.textContent = c.description;
      sel.appendChild(o);
    });

    function show(r, v) { return r.names ? r.names[v] : v + (r.unit ? " " + r.unit : ""); }

    function setup() {
      var c = conds[sel.value], r = RANGES[c.dataType];
      val.min = r.min; val.max = r.max; val.step = 1;
      val.value = c.operator === "gt" ? Math.round((r.min + c.threshold) / 2) : Math.round((r.max + c.threshold) / 2);
      if (c.operator === "eq") val.value = r.max;
      var maxDur = Math.max(c.sustainedSeconds * 2, 60);
      dur.max = maxDur;
      dur.step = maxDur > 600 ? 30 : 10;
      dur.value = 0;
      dur.disabled = c.sustainedSeconds === 0;
      $("rule").textContent =
        c.dataType + " " + OPS[c.operator].sym + " " + (r.names ? r.names[c.threshold] : c.threshold) +
        "，持续 " + fmtTime(c.sustainedSeconds) + "，触发后静默 " + fmtTime(c.cooldownSeconds);
      update();
    }

    function update() {
      var c = conds[sel.value], r = RANGES[c.dataType];
      var v = Number(val.value), d = Number(dur.value);
      $("val-out").textContent = show(r, v);
      $("dur-out").textContent = c.sustainedSeconds === 0 ? "无需持续" : fmtTime(d);

      var hit = OPS[c.operator].test(v, c.threshold);
      var held = hit && d >= c.sustainedSeconds;
      var state, verdict, reason;

      if (!hit) {
        state = "idle";
        verdict = "未命中，闸门关闭";
        reason = "这个读数不满足条件，样本在本地被丢弃，没有调用 LLM，也没有额外耗电。";
      } else if (!held) {
        state = "wait";
        verdict = "命中，还没持续够";
        reason = "条件已满足，但要持续 " + fmtTime(c.sustainedSeconds) + " 才放行，目前 " + fmtTime(d) + "。短暂波动不会打扰你。";
      } else {
        state = "fire";
        verdict = "放行，唤醒 LLM";
        reason = "条件持续成立，事件越过闸门交给 LLM 判断，再以振动提醒。随后进入 " + fmtTime(c.cooldownSeconds) + " 静默期，不会反复提醒。";
      }

      var box = $("result");
      box.dataset.state = state;
      $("verdict").textContent = verdict;
      $("reason").textContent = reason;
      var on = { sense: true, gate: hit, llm: held, haptic: held };
      box.querySelectorAll("[data-node]").forEach(function (li) {
        li.classList.toggle("on", !!on[li.dataset.node]);
      });

      // 表盘联动：心率条件下，表盘读数跟着滑块走
      var face = document.querySelector(".face");
      if (c.dataType === "heart_rate") {
        $("bpm").textContent = v;
        $("face-state").textContent = held ? "闸门放行" : hit ? "命中 · 持续观察" : "闸门未触发";
      }
      face.dataset.alert = held ? "true" : "false";
    }

    sel.addEventListener("change", setup);
    val.addEventListener("input", update);
    dur.addEventListener("input", update);
    setup();
  }

  /* ---------- 能力清单 ---------- */
  function initCaps(data) {
    var root = $("caps");
    (data.capabilities || []).forEach(function (c) {
      var done = c.status === "implemented";
      var card = document.createElement("article");
      card.className = "cap" + (done ? "" : " plan");
      var h = document.createElement("h3"); h.textContent = c.name;
      var p = document.createElement("p"); p.textContent = c.description;
      var t = document.createElement("span");
      t.className = "tag " + (done ? "ok" : "plan");
      t.textContent = done ? "已实现" : "规划中";
      card.append(h, p, t);
      root.appendChild(card);
    });
  }

  function failCaps() {
    var p = document.createElement("p");
    p.className = "note";
    p.textContent = "能力清单暂时加载不出来，请直接查看仓库里的 common/capabilities/watch-capabilities.json。";
    $("caps").appendChild(p);
  }

  /* ---------- 复制命令 ---------- */
  function initCopy() {
    document.querySelectorAll("[data-copy]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var text = document.querySelector(btn.dataset.copy).textContent;
        var done = function (msg) {
          btn.textContent = msg;
          setTimeout(function () { btn.textContent = "复制"; }, 1600);
        };
        if (navigator.clipboard) {
          navigator.clipboard.writeText(text).then(function () { done("已复制"); }, function () { done("复制失败"); });
        } else {
          done("复制失败");
        }
      });
    });
  }

  /* ---------- 滚动显现（无 JS 时内容默认可见） ---------- */
  function initReveal() {
    if (!("IntersectionObserver" in window) || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      });
    }, { threshold: 0.12 });
    document.querySelectorAll(".section-head, .steps li, .demo, .cap, .terminal, .boundary").forEach(function (el) {
      el.classList.add("reveal");
      io.observe(el);
    });
  }

  load(SOURCES.gates).then(initDemo, function () {
    $("verdict").textContent = "闸门条件加载失败";
    $("reason").textContent = "请直接查看仓库里的 common/models/gate-conditions.json。";
  });
  load(SOURCES.caps).then(function (d) { initCaps(d); initReveal(); }, function () { failCaps(); initReveal(); });
  initCopy();
})();
