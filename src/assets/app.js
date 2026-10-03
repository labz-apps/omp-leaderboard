// Progressive enhancement only. Every number on the page is already in the HTML;
// nothing here fetches, computes, or injects data.
(function () {
  "use strict";

  // Deep-link to a benchmark section without a server: the nav is plain HTML,
  // this only adds a highlight when arriving via a hash.
  var target = window.location.hash ? document.querySelector(window.location.hash) : null;
  if (target) {
    target.classList.add("benchmark-highlight");
    window.setTimeout(function () {
      target.classList.remove("benchmark-highlight");
    }, 1600);
  }

  // Make wide tables horizontally scrollable with a visible affordance on
  // devices where the scrollbar is hidden.
  Array.prototype.forEach.call(document.querySelectorAll(".table-scroll"), function (el) {
    el.setAttribute("tabindex", "0");
    el.setAttribute("role", "region");
    if (!el.getAttribute("aria-label")) {
      el.setAttribute("aria-label", "Scrollable table");
    }
    el.addEventListener("scroll", function () {
      el.classList.toggle("is-scrolled", el.scrollLeft > 0);
    });
  });
})();
