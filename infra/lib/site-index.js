// CloudFront Function `ssd-workshop-site-index` (ticket 3.11), viewer request on `/facilitator*` and (ticket 3.24)
// `/app-sign-in*`, runtime cloudfront-js-2.0. The site bucket holds the facilitator dashboard as
// `facilitator/index.html` and its script as `facilitator/dashboard.js`, and the hand-off page for saving in apps as
// `app-sign-in/index.html`; S3 has no folder index, and the distribution's default root object covers `/` only:
// - `/facilitator` and `/app-sign-in` (no slash) answer 301 to the folder (`/facilitator/`, `/app-sign-in/`), keeping
//   the query (`/app-sign-in?app=ada` -> `/app-sign-in/?app=ada`);
// - a path ending in `/` asks the bucket for `index.html` in that folder.
// Anything else goes to the bucket unchanged; a missing key becomes the plain 404 page (distribution error response).
// Tested by evaluating this file (infra/lib/site-index.test.ts); plain ES5 so it runs on any CloudFront Functions runtime.

function queryOf(querystring) {
  var parts = [];
  for (var name in querystring) {
    var entry = querystring[name];
    var values = entry.multiValue ? entry.multiValue : [entry];
    for (var i = 0; i < values.length; i++) {
      parts.push(values[i].value === "" ? name : name + "=" + values[i].value);
    }
  }
  return parts.length ? "?" + parts.join("&") : "";
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- CloudFront calls it by name
function handler(event) {
  var request = event.request;
  if (request.uri === "/facilitator" || request.uri === "/app-sign-in") {
    return {
      statusCode: 301,
      statusDescription: "Moved Permanently",
      headers: { location: { value: request.uri + "/" + queryOf(request.querystring) } },
    };
  }
  if (request.uri.charAt(request.uri.length - 1) === "/") request.uri += "index.html";
  return request;
}
