# Infrastructure

AWS CDK app (TypeScript). Nothing is deployed from a session: stacks deploy from `main` only
(ticket 0.5). `infra/access/access-stack.yaml` is applied by Franck only.

## Stacks

| Stack | Region | What | Synthesizer |
| --- | --- | --- | --- |
| `ssd-workshop-cdk-assets` | eu-central-1 | `ssd-workshop-cdk-assets-<account>` bucket for CDK file assets | inline template (`LegacyStackSynthesizer`) |
| `ssd-workshop-site` | eu-central-1 | private `ssd-workshop-site-<account>` bucket, pages from `platform/web` (BucketDeployment) | `CliCredentialsStackSynthesizer`, assets bucket |
| `ssd-workshop-edge` | us-east-1 | ACM certificate, CloudFront (Origin Access Control), A/AAAA records for `workshop.rankly.games` | inline template (`LegacyStackSynthesizer`) |

Deploy order: cdk-assets, then site, then edge. Nothing is passed between regions: the edge
stack finds the site bucket by its fixed name, and the site bucket policy lets this account's
CloudFront distributions read it.

```sh
npm run synth   # cdk synth, no AWS credentials needed
npm test        # template assertions (infra/lib/app.test.ts)
```

## Checks after the first deploy (ticket 0.4 criteria 1, 2, 4, 5)

Read-only; run them after the deploy workflow has finished on `main`.

**Before the first deploy** (once), snapshot the zone for criterion 5:

```sh
aws route53 list-resource-record-sets --region us-east-1 \
  --hosted-zone-id Z0232668P02TE2FEZL28 --output json > zone-before.json
```

1. HTTPS answers 200 with the placeholder page:

   ```sh
   curl -sS -o /dev/null -w '%{http_code} %{ssl_verify_result}\n' https://workshop.rankly.games/
   # expect: 200 0
   curl -sS https://workshop.rankly.games/ | grep -c 'SSD Workshop, coming soon'
   # expect: 2 or more (title and heading)
   ```

2. The bucket refuses direct requests (only CloudFront can read it):

   ```sh
   curl -sS -o /dev/null -w '%{http_code}\n' \
     https://ssd-workshop-site-360206963848.s3.eu-central-1.amazonaws.com/index.html
   # expect: 403
   aws s3api get-bucket-policy-status --region eu-central-1 \
     --bucket ssd-workshop-site-360206963848 --query PolicyStatus.IsPublic
   # expect: false
   aws s3api get-public-access-block --region eu-central-1 \
     --bucket ssd-workshop-site-360206963848
   # expect: all four settings true
   ```

4. HTTP redirects to HTTPS:

   ```sh
   curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' http://workshop.rankly.games/
   # expect: 301 https://workshop.rankly.games/
   ```

5. Only the workshop records changed in the rankly.games zone:

   ```sh
   aws route53 list-resource-record-sets --region us-east-1 \
     --hosted-zone-id Z0232668P02TE2FEZL28 --output json > zone-after.json
   diff zone-before.json zone-after.json
   # expect: only added records named workshop.rankly.games. (A, AAAA)
   # and _<hash>.workshop.rankly.games. (CNAME, certificate validation)
   ```

   The deploy policy also refuses any record outside `workshop.rankly.games` and
   `*.workshop.rankly.games`.

Criterion 3 (tags and boundary) is proven by `npm test` on the synthesized templates.
