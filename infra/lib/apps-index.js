// CloudFront Function `ssd-workshop-apps-index` (ticket 2.5), viewer request on `/apps/*`, runtime
// cloudfront-js-2.0. An app's files live under the S3 key `apps/<lower-cased nickname>/`:
// - `/apps/<nickname>` (no slash after the nickname) answers 301 to `/apps/<nickname>/`, so the page's
//   relative links (style.css, app.js) resolve inside the app;
// - a nickname with upper-case letters answers 301 to its lower-case address (the rest of the path is
//   kept as it is: file names keep their case);
// - a path ending in `/` asks the bucket for `index.html` in that folder.
// The query string is kept on a redirect. Anything else goes to the bucket unchanged; a missing key
// becomes the plain 404 page (distribution error response). Tested by evaluating this file
// (infra/lib/apps-index.test.ts); plain ES5 so it runs on any CloudFront Functions runtime.

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
  var match = /^\/apps\/([A-Za-z0-9-]+)(\/.*)?$/.exec(request.uri);
  if (match) {
    var nickname = match[1];
    var rest = match[2];
    var lower = nickname.toLowerCase();
    if (rest === undefined || lower !== nickname) {
      return {
        statusCode: 301,
        statusDescription: "Moved Permanently",
        headers: { location: { value: "/apps/" + lower + (rest === undefined ? "/" : rest) + queryOf(request.querystring) } },
      };
    }
  }
  if (request.uri.charAt(request.uri.length - 1) === "/") request.uri += "index.html";
  return request;
}
