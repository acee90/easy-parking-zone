# Anthropic Code Review 출시 및 설치 후기

## 1. Anthropic Code Review 도입

최근 Anthropic에서 **Claude Code Review**가 출시되었습니다. 공식 문서의 [Quick Setup](https://code.claude.com/docs/en/github-actions) 가이드를 따라 `/install-github-app` 명령어로 설치를 진행해 보았습니다.

---

## 2. 설치 및 자동 PR 생성

터미널에서 아래 명령어를 실행하면 브라우저를 통해 GitHub App 설치 권한 승인 단계로 연결됩니다.

```bash
/install-github-app
```

설치를 마치면 Claude가 해당 레포지토리에 GitHub Actions 설정 파일을 포함한 **Pull Request(PR)**를 자동으로 생성해 줍니다. 직접 YAML 파일을 작성할 필요 없이 바로 워크플로우를 구성할 수 있다는 점이 편리합니다.

---

## 3. GitHub Actions 설정 및 권한 주의사항

자동 생성된 `.github/workflows/claude-code-review.yml` 파일의 전체 코드입니다.

```yaml
name: Claude Code Review

on:
  pull_request:
    types: [opened, synchronize, reopened]
    paths:
      - "**.js"
      - "**.ts"
      - "**.jsx"
      - "**.tsx"

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - name: Anthropic Code Review
        uses: anthropic-ai/claude-code-review-action@v1
```

설치 과정에서 주의할 점은 **권한(Permissions)** 설정입니다. 초기 설정 시 권한이 `read`로만 되어 있으면 리뷰 로직은 돌아가지만, 정작 PR에 코멘트를 남기지 못하는 상황이 발생할 수 있습니다.

리뷰 결과가 코멘트로 남지 않는다면 `pull-requests: write` 권한이 제대로 부여되었는지 확인이 필요합니다.

자동으로 생성된 .yml파일에는 저는 둘다 read로 들어가있어서. claude.yml, claude-review.yml 둘다 확인하시길 바랍니다

---

## 4. 사용 후기 및 Gemini Code Review와 비교

최근까지 사용하던 Gemini Code Review와 비교했을 때 몇 가지 차이점이 느껴졌습니다.

### 1) 진행 상황의 가시성

- **Gemini**: PR 생성 시 요약(Summary)은 빠르지만, 내부적인 진행 상태(Progress)가 보이지 않습니다. 특히 `/gemini review`로 수동 호출할 때 명령이 처리 중인지, 아니면 오류가 난 것인지 알기 어려운 경우가 있었습니다.
- **Claude**: GitHub Actions의 진행 상황을 통해 현재 리뷰가 어느 단계인지 명확하게 확인할 수 있어 답답함이 덜합니다.

### 2) 속도와 리뷰 퀄리티

- **속도**: Gemini에 비해 상당히 느린 편입니다. 약 100줄 정도의 수정 사항을 기준으로 Gemini는 1분 내외가 소요된 반면, Claude는 5분 정도 걸렸습니다.
- **퀄리티**: 속도는 아쉽지만 리뷰의 디테일과 퀄리티는 만족스럽습니다. 단순한 코드 수정을 넘어 로직의 흐름을 짚어주는 느낌을 받았습니다.

---

## 5. 마치며

속도 면에서의 아쉬움은 있지만, 진행중인지를 볼수있다는 점과, 리뷰 퀄리티가 마음에 들어서 계속 사용해볼 생각입니다.

끝.

---

### 🏷️ 태그 (Tag)

#개발일기 #Claude #Anthropic #CodeReview #GitHubActions #자동화 #사이드프로젝트
