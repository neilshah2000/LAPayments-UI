#!/bin/sh
# Deploy HEAD to the ECS Express service: build, push, register, update, wait.
#
# The steps are the ones in deploy/README.md, in the order the gotchas there demand:
#   - refuses a dirty tree, because the image tag is the commit and must describe the source
#   - confirms the image is in ECR before touching the service; a deployment started ahead of
#     its image trips the circuit breaker and never recovers on its own
#   - waits for THIS revision's rollout to reach COMPLETED or FAILED, then checks /api/health
#
# Needs Docker running and AWS credentials. The account is whichever those credentials belong
# to; deploy/*.json carry an ACCOUNT_ID placeholder that is filled in here.
set -eu
export AWS_PAGER=""

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION=us-east-1
CLUSTER=lapayments
SERVICE=lapayments-ui
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
REPO="$REGISTRY/lapayments-ui"
TIMEOUT_S="${LAP_DEPLOY_TIMEOUT_S:-1200}" # last rollout took ~9 min

cd "$(dirname "$0")/.."
step() { printf '\n==> %s\n' "$*"; }

if [ -n "$(git status --porcelain)" ]; then
  echo "working tree is not clean -- commit or stash first, so the image tag matches its source:" >&2
  git status --short >&2
  exit 1
fi
TAG=$(git rev-parse --short HEAD)
echo "deploying $TAG: $(git log -1 --format=%s)"

step "build"
npm run docker:build

step "push $REPO:$TAG"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"
docker tag lapayments-ui:latest "$REPO:$TAG"
docker push "$REPO:$TAG"
aws ecr describe-images --repository-name lapayments-ui --image-ids imageTag="$TAG" --region "$REGION" \
  --query 'imageDetails[0].imagePushedAt' --output text >/dev/null

step "register task definition"
TD_JSON=$(mktemp)
trap 'rm -f "$TD_JSON"' EXIT
sed -e "s/IMAGE_TAG/$TAG/" -e "s/ACCOUNT_ID/$ACCOUNT/g" deploy/task-definition-express.json > "$TD_JSON"
TD=$(aws ecs register-task-definition --cli-input-json "file://$TD_JSON" --region "$REGION" \
     --query 'taskDefinition.taskDefinitionArn' --output text)
echo "$TD"

step "update service"
SVC=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" \
      --query 'services[0].serviceArn' --output text)
aws ecs update-express-gateway-service --service-arn "$SVC" --task-definition-arn "$TD" \
  --region "$REGION" >/dev/null

step "wait for rollout (up to ${TIMEOUT_S}s)"
start=$(date +%s)
while :; do
  # Tab-separated: rolloutState, runningCount, failedTasks, rolloutStateReason.
  state=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" \
          --query "services[0].deployments[?taskDefinition=='$TD'] | [0].[rolloutState,runningCount,failedTasks,rolloutStateReason]" \
          --output text)
  elapsed=$(( $(date +%s) - start ))
  printf '%4ss  %s\n' "$elapsed" "$(echo "$state" | cut -f1-3)"
  case "$state" in
    COMPLETED*) break ;;
    FAILED*)
      echo "rollout FAILED: $(echo "$state" | cut -f4)" >&2
      echo "see 'Recover a failed deployment' in deploy/README.md" >&2
      exit 1 ;;
  esac
  if [ "$elapsed" -ge "$TIMEOUT_S" ]; then
    echo "still not COMPLETED after ${TIMEOUT_S}s -- the deployment carries on; check it by hand" >&2
    exit 1
  fi
  sleep 20
done

step "health"
HOST=$(aws ecs describe-express-gateway-service --service-arn "$SVC" --region "$REGION" \
       --query 'service.activeConfigurations[0].ingressPaths[0].endpoint' --output text)
curl -fsS "https://$HOST/api/health"
printf '\n\ndeployed %s to https://%s/\n' "$TAG" "$HOST"
