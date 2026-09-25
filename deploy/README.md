# Deploying to ECS

Region `us-east-1`, bucket `s3://lapayments-<account-id>`. The account ID is not written
down anywhere in this repo: the commands below read it from your credentials, and the JSON
files carry an `ACCOUNT_ID` placeholder filled in at the point of use. Start a shell with:

```sh
export AWS_PAGER=""
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
fill() { sed "s/ACCOUNT_ID/$ACCOUNT/g" "$1"; }   # deploy/*.json with the account filled in
```

`AWS_PAGER=""` matters: without it (or `--no-cli-pager` on each command) output opens in
`less` and looks like the command hung.

## What is in this directory

| File | What it is | Used by |
|---|---|---|
| `ecs-trust-policy.json` | trust policy: lets ECS assume both roles | one-time IAM setup |
| `task-role-s3-policy.json` | read-only on `serving/` and `registers/serving_files.csv`, for the task role | one-time IAM setup (re-apply when it changes) |
| `ecs-exec-policy.json` | `ssmmessages:*`, only needed for `execute-command` | optional |
| `task-definition.json` | one-off `run-task` blueprint, `IMAGE_TAG` placeholder | ad-hoc testing |
| `task-definition-express.json` | the **service** blueprint for ECS Express Mode | every real deploy |
| `express-infra-trust-policy.json` | trust policy for the Express infrastructure role | one-time IAM setup |

`task-definition.json` is a template: the image tag is substituted at deploy time. The
substituted copy is written to `/tmp` and is **not** committed -- it is derived, and
committing it would let it drift from the template.

## One-time setup

Already done for this account; kept for rebuilding from scratch or in another account.

```sh
# 1. Roles. Both use the same trust policy.
aws iam create-role --role-name ecsTaskExecutionRole \
  --assume-role-policy-document "$(fill deploy/ecs-trust-policy.json)"
aws iam attach-role-policy --role-name ecsTaskExecutionRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

aws iam create-role --role-name lapaymentsTaskRole \
  --assume-role-policy-document "$(fill deploy/ecs-trust-policy.json)"
aws iam put-role-policy --role-name lapaymentsTaskRole \
  --policy-name lapaymentsServingRead \
  --policy-document "$(fill deploy/task-role-s3-policy.json)"

# 2. Log group. NOT optional -- see Gotchas.
aws logs create-log-group --log-group-name /ecs/lapayments-ui --region us-east-1
aws logs put-retention-policy --log-group-name /ecs/lapayments-ui --retention-in-days 30 \
  --region us-east-1   # default is never expire

# 3. Image registry and cluster.
aws ecr create-repository --repository-name lapayments-ui --region us-east-1
aws ecs create-cluster --cluster-name lapayments --region us-east-1

# 4. Optional: shell access into a running task (also needs session-manager-plugin locally)
aws iam put-role-policy --role-name lapaymentsTaskRole \
  --policy-name lapaymentsEcsExec --policy-document file://deploy/ecs-exec-policy.json

# 5. For ECS Express Mode: the role it uses to provision the ALB, target groups,
#    scaling policies and networking on your behalf. Note the lowercase "for" in the
#    policy name -- it is easy to mistype and the error is unhelpful.
aws iam create-role --role-name ecsInfrastructureRoleForExpressServices \
  --assume-role-policy-document "$(fill deploy/express-infra-trust-policy.json)"
aws iam attach-role-policy --role-name ecsInfrastructureRoleForExpressServices \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRoleforExpressGatewayServices
```

Verify the permissions resolve before launching anything -- this catches a
misconfiguration in seconds instead of via a failed task:

```sh
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::$ACCOUNT:role/lapaymentsTaskRole \
  --action-names s3:GetObject \
  --resource-arns arn:aws:s3:::lapayments-$ACCOUNT/serving/SWK.parquet \
  --query 'EvaluationResults[].[EvalActionName,EvalDecision]' --output text
# expect: s3:GetObject  allowed
```

## Deploy (ECS Express Mode) -- the real path

**Normally: `npm run deploy`.** `scripts/deploy.sh` does the build, push, register, update and
wait below in the right order for the committed HEAD, refuses a dirty tree, and exits non-zero
if the rollout fails or `/api/health` does not answer. The steps are spelled out here for the
first deploy (`create-express-gateway-service`, which the script does not do) and for
recovering by hand.

Express Mode provisions an ECS service on Fargate, an Application Load Balancer, target
groups, health checks, auto scaling and networking from one call. Provisioning takes 3-5
minutes.

```sh
TAG=$(git rev-parse --short HEAD)
npm run docker:build
# ... tag + push as in the section below ...

fill deploy/task-definition-express.json | sed "s/IMAGE_TAG/$TAG/" > /tmp/td-express.json
aws ecs register-task-definition --cli-input-json file:///tmp/td-express.json --region us-east-1

aws ecs create-express-gateway-service \
  --service-name lapayments-ui \
  --cluster lapayments \
  --infrastructure-role-arn arn:aws:iam::$ACCOUNT:role/ecsInfrastructureRoleForExpressServices \
  --task-definition-arn arn:aws:ecs:us-east-1:$ACCOUNT:task-definition/lapayments-ui-express:1 \
  --health-check-path /api/health \
  --scaling-target '{"minTaskCount":1,"maxTaskCount":2}' \
  --region us-east-1
```

Subsequent deploys register a new revision and update the service:

```sh
SVC=$(aws ecs describe-services --cluster lapayments --services lapayments-ui \
      --query 'services[0].serviceArn' --output text --region us-east-1)
aws ecs update-express-gateway-service --service-arn $SVC \
  --task-definition-arn <new-revision-arn> --region us-east-1
```

Note `update-express-gateway-service` takes `--service-arn`, not the `--cluster` +
`--service-name` pair that `create-express-gateway-service` and `describe-services` use.

### Recover a failed deployment

If the rollout state is `FAILED`, the circuit breaker has stopped retrying and the service
will not recover on its own -- even once the underlying problem is fixed. Re-issue the
**same** task definition to trigger a fresh deployment:

```sh
SVC=$(aws ecs describe-services --cluster lapayments --services lapayments-ui \
      --query 'services[0].serviceArn' --output text --region us-east-1)
TD=$(aws ecs describe-task-definition --task-definition lapayments-ui-express \
     --query 'taskDefinition.taskDefinitionArn' --output text --region us-east-1)

aws ecs update-express-gateway-service --service-arn $SVC \
  --task-definition-arn $TD --region us-east-1

# watch it roll: IN_PROGRESS -> COMPLETED
aws ecs describe-services --cluster lapayments --services lapayments-ui --region us-east-1 \
  --query 'services[0].deployments[].[rolloutState,runningCount,failedTasks]' --output text
```

Nothing about the service is being changed here -- passing the same ARN is simply how you
ask for a new deployment attempt. Fix the cause first (usually a missing image), or the
circuit breaker just trips again.

Status, and the public URL:

```sh
aws ecs describe-services --cluster lapayments --services lapayments-ui --region us-east-1 \
  --query 'services[0].[status,desiredCount,runningCount]' --output text
aws elbv2 describe-load-balancers --region us-east-1 \
  --query 'LoadBalancers[].[DNSName,State.Code]' --output text
```

### Why the Express task definition differs

`task-definition-express.json` is a separate family (`lapayments-ui-express`) because Express
Mode imposes requirements the plain one does not:

- the container **must** be named `Main`
- its port mapping **must** carry a `name` (`"name": "http"`)
- `--cpu`, `--memory`, `--execution-role-arn` and `--task-role-arn` cannot be passed on the
  command when `--task-definition-arn` is used; they live in the JSON

That last point is why the task-definition route is the only way to get ARM64: Express Mode's
inline `--primary-container` has no runtime-platform option, but a task definition does.

It is also sized 512 CPU / 1024 MB rather than 1024/2048 -- measured, the boot warm is
identical (44.0s vs 43.4s) because the work is I/O bound on S3, and peak RSS is 626 MiB.
That halves the task cost. `LAP_MEMORY_LIMIT=700MB` is set to match.

### Cost

The ALB is billed whether or not anyone visits: **$0.0225/hour (~$16.40/month)** plus LCU
charges, on top of ~$14.40/month for one 512/1024 ARM task. Delete the service to stop both.

## Deploy (one-off `run-task`) -- ad-hoc testing

```sh
# 1. Build. `docker:build` stages the catalogue CSVs first -- see Gotchas.
npm run docker:build

# 2. Tag with the commit, so a running task traces back to its source.
TAG=$(git rev-parse --short HEAD)
REPO=$ACCOUNT.dkr.ecr.us-east-1.amazonaws.com/lapayments-ui

aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.us-east-1.amazonaws.com
docker tag lapayments-ui:latest $REPO:$TAG
docker push $REPO:$TAG

# 3. Register a revision pointing at that image.
fill deploy/task-definition.json | sed "s/IMAGE_TAG/$TAG/" > /tmp/td.json
aws ecs register-task-definition --cli-input-json file:///tmp/td.json --region us-east-1

# 4. Run it.
aws ecs run-task --cluster lapayments --launch-type FARGATE \
  --task-definition lapayments-ui \
  --network-configuration 'awsvpcConfiguration={subnets=["<public-subnet-id>"],securityGroups=["<security-group-id>"],assignPublicIp=ENABLED}' \
  --region us-east-1
```

Commit before tagging. `git rev-parse HEAD` resolves at the moment you run it, so
committing after the push gives you a tag that points at the wrong source.

## Verify

```sh
aws logs tail /ecs/lapayments-ui --follow --region us-east-1
```

`profiled N/N councils in NNNNN ms` is the one line that matters: it only appears if every
`read_parquet('s3://...')` succeeded, which means the task role resolved credentials over
`169.254.170.2`.

Measured in-region on Fargate (1 vCPU), 2026-09-23:

| | per council | 29 councils | projected @382 |
|---|---|---|---|
| `LAP_POOL_SIZE=1` | 1867 ms | ~54 s | ~12 min |
| `LAP_POOL_SIZE=8` (default) | **707 ms** | **20.5 s** | ~4.5 min |

The pool hides S3 latency behind concurrent range reads, so the gain is larger off-region
(4.1x from a laptop) than in-region (2.6x), where there is less latency to hide.

This number sizes the health-check grace period, and it also bounds how long a post-rebuild
`/api/councils` can take: that request re-profiles every changed council inline, so at
707 ms each it crosses the ALB's default 60 s idle timeout somewhere around 84 councils.
Past that, profile persistence (`profiles/{la_code}/{sha256}.json`) becomes necessary
rather than optional.

`unavailable: XXX -- HTTP 404` means the catalogue lists a council whose Parquet is not in
S3 yet -- the collection side mid-rebuild. The service stays up and serves the rest; the
aggregate endpoints return 503 for that council until the file lands.

Task state, and the exit code on stop:

```sh
aws ecs list-tasks --cluster lapayments --region us-east-1
aws ecs describe-tasks --cluster lapayments --tasks <task-id> --region us-east-1 \
  --query 'tasks[0].[lastStatus,containers[0].exitCode,stoppedReason]' --output text
```

A clean stop is `SIGTERM: shutting down` in the logs and **exitCode 0**. Anything else on an
ordinary deploy is a regression in signal handling.

## Stop

Tasks bill while they run, and an Express service's ALB bills even while idle.

```sh
# a one-off run-task
aws ecs stop-task --cluster lapayments --region us-east-1 \
  --task $(aws ecs list-tasks --cluster lapayments --desired-status RUNNING \
           --query 'taskArns[0]' --output text --region us-east-1)

# an Express service: stopping its task is not enough, the service restarts it.
# Scale to zero to keep the ALB, or delete to stop all charges.
SVC=$(aws ecs describe-services --cluster lapayments --services lapayments-ui \
      --query 'services[0].serviceArn' --output text --region us-east-1)
aws ecs update-express-gateway-service --service-arn $SVC \
  --scaling-target '{"minTaskCount":0,"maxTaskCount":2}' --region us-east-1
aws ecs delete-express-gateway-service --service-arn $SVC --region us-east-1
```

## Gotchas

Each of these was hit for real; none is guessable from the docs.

**`file://` needs three slashes for an absolute path.** `file:///tmp/td.json`. Two slashes
makes it relative and the call fails. Paths under the repo (`file://deploy/x.json`) take two.

**The execution role cannot create the log group.** `AmazonECSTaskExecutionRolePolicy`
grants `logs:CreateLogStream` and `logs:PutLogEvents` but *not* `logs:CreateLogGroup`, so
`awslogs-create-group: true` fails the log driver and the task never starts. Create the
group up front instead.

**`s3:ListBucket` is load-bearing, not padding.** Without it S3 answers **403** for a
missing key instead of 404, because it will not confirm non-existence to a caller that
cannot list. `isMissingData()` in `src/db.ts` keys the degraded path off the 404, so
without `ListBucket` a missing council surfaces as an opaque 500 rather than a clean 503.

**Build for ARM64 on both sides.** The DuckDB native binding *and* the baked httpfs/aws
extension binaries are platform-keyed. `--platform=linux/arm64` must match
`runtimePlatform.cpuArchitecture: ARM64`. Confirm what was actually pushed:

```sh
aws ecr batch-get-image --repository-name lapayments-ui --image-ids imageTag=$TAG \
  --query 'images[0].imageManifest' --output text | python3 -c \
  "import json,sys; print(json.load(sys.stdin)['config']['digest'])"
# then fetch that config blob and check .architecture == arm64
```

**`serving_files.csv` is read live; `councils_master.csv` is baked in.** The weekly job
publishes `serving_files.csv` to `s3://…/registers/`, and the Express task points
`LAP_REGISTERS_DIR` there, so a rebuilt or newly added council reaches the app within
`LAP_CATALOGUE_TTL_MS` (60s) with no redeploy -- profiles recompute because they are keyed on
each council's `sha256`. `councils_master.csv` is not in S3, so it is still staged by
`scripts/stage-catalogue.sh` (run by `npm run docker:build`; Docker will not follow the
`data/` symlinks) and only changes with a rebuild. A council in `serving_files.csv` but not
in the baked master is served by the aggregates but silently missing from `/councils`.
The one-off `task-definition.json` does not set `LAP_REGISTERS_DIR`, so it serves the baked
copy of both.

**`readonlyRootFilesystem` needs a writable `/tmp`, not just `/tmp/duckdb`.** tsx writes its
compile cache to `/tmp/tsx-<uid>` and fails at startup with
`ENOENT: mkdir '/tmp/tsx-1000'` otherwise. Fargate does not support the `tmpfs` container
parameter (EC2 only), so this needs a task `volumes` + `mountPoints` pair. Not enabled in
the current task definition.

**`execute-command` needs two things.** The `ssmmessages:*` policy above *and*
`session-manager-plugin` installed locally (`brew install --cask session-manager-plugin`).
Without both, `--enable-execute-command` launches fine but you cannot get a shell. Do not
open port 3000 on the security group as a workaround -- it exposes an unauthenticated
service, and the licence/attribution question is still open.

**Push the image before creating or updating the service.** An Express service has a
deployment circuit breaker: after a handful of failed task starts it marks the deployment
FAILED and stops retrying. It does **not** pick the image up later. Seen for real -- the
circuit breaker tripped at 18:39 and the image was pushed at 18:46, and nothing recovered
until a new deployment was triggered with `update-express-gateway-service`. Check the
rollout state with:

```sh
aws ecs describe-services --cluster lapayments --services lapayments-ui --region us-east-1 \
  --query 'services[0].deployments[].[status,rolloutState,rolloutStateReason,failedTasks]' \
  --output text
```

**`git rev-parse HEAD` resolves when you run it, not when you pushed.** Committing after the
push gives a task definition pointing at a tag that does not exist, and the failure arrives
as `CannotPullContainerError` minutes later. Push first, or pass the tag literally.

**An Express service restarts a task you stop.** `stop-task` against a service-managed task
just triggers a replacement -- which also means it pays the boot warm again. Scale the
service to zero or delete it instead.

**`LAP_SKIP_WARM=1` for infrastructure testing.** Opens the port in ~1.5 s and computes
profiles on demand, so an iteration costs seconds instead of the full warm. Leave it unset
in anything real -- and note the warm is also what proves the S3 path end to end.

## Environment variables

| Variable | Purpose |
|---|---|
| `LAP_DATA_DIR` | local dir or `s3://bucket`; `serving/{la}.parquet` is joined onto it |
| `LAP_CATALOGUE_DIR` | where the two CSVs live; the image bakes this to `/app/catalogue` |
| `LAP_REGISTERS_DIR` | overrides where `serving_files.csv` alone is read from; the Express task sets `s3://…/registers` |
| `LAP_SKIP_WARM` | skip the boot warm; profiles computed on demand |
| `LAP_MEMORY_LIMIT` | DuckDB memory cap. Set it: DuckDB takes ~80% of the task otherwise, leaving Node squeezed. 1400MB on a 2048MB task |
| `LAP_THREADS` | DuckDB threads; unset is fine, it reads the cgroup correctly |
| `LAP_TEMP_DIR` | DuckDB spill directory; image sets `/tmp/duckdb` |
| `LAP_CATALOGUE_TTL_MS` | catalogue reload interval (default 60s) |
| `LAP_SECRET_REFRESH_MS` | s3 credential re-issue interval (default 5 min) |
| `LAP_CACHE_MAX_AGE_S` | how long a browser reuses a successful `/api` response (default 300) |
| `LAP_RATE_BURST` / `LAP_RATE_PER_MIN` | per-client-IP rate limit on `/api` except `/api/health` (defaults 120 / 120); 429 with `Retry-After` past it. Per task, not global |
| `LAP_WEB_DIR` | built web assets; image sets `./web/dist` |
| `AWS_REGION` | pins the region on the s3 secret; otherwise resolved like the CLI does |

`LAP_SECRET_REFRESH_MS` is not optional tuning. DuckDB's `credential_chain` resolves once,
at `CREATE SECRET`, and caches the result -- `REFRESH auto` does not change this (measured).
ECS task-role credentials are temporary STS credentials, so without periodic re-issue the
service works for a while and then starts failing with 403s. Re-issuing the secret does
force a fresh fetch; that is what the timer does. STS sessions run 15 min to 12 h, so the
5-minute default sits inside even the shortest session STS can issue.
