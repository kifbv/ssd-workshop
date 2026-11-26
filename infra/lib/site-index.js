// CloudFront Function `ssd-workshop-site-index` (ticket 3.11), viewer request on `/facilitator*`, runtime
// cloudfront-js-2.0. The site bucket holds the facilitator dashboard as `facilitator/index.html` and its script as
// `facilitator/dashboard.js`; S3 has no folder index, and the distribution's default root object covers `/` only:
// - `/facilitator` (no slash) answers 301 to `/facilitator/`, keeping the query;
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
  if (request.uri === "/facilitator") {
    return {
      statusCode: 301,
      statusDescription: "Moved Permanently",
      headers: { location: { value: "/facilitator/" + queryOf(request.querystring) } },
    };
  }
  if (request.uri.charAt(request.uri.length - 1) === "/") request.uri += "index.html";
  return request;
}
