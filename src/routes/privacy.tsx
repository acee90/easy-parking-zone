import { createFileRoute } from '@tanstack/react-router'
import { LegalSection, LegalShell } from '@/components/legal/LegalShell'
import { CONTACT_EMAIL, LEGAL_EFFECTIVE_DATE, PRIVACY_OFFICER, SITE_NAME } from '@/lib/site'

export const Route = createFileRoute('/privacy')({
  head: () => ({
    meta: [
      { title: '개인정보처리방침 | 쉬운주차장' },
      { name: 'robots', content: 'noindex, follow' },
    ],
    links: [{ rel: 'canonical', href: 'https://easy-parking.xyz/privacy' }],
  }),
  component: PrivacyPage,
})

function PrivacyPage() {
  return (
    <LegalShell title="개인정보처리방침" updatedAt={LEGAL_EFFECTIVE_DATE}>
      <LegalSection heading="1. 총칙">
        <p>
          {SITE_NAME}(이하 “서비스”)는 「개인정보 보호법」 등 관련 법령을 준수하며, 이용자의
          개인정보를 보호하기 위해 본 개인정보처리방침을 수립·공개합니다. 본 방침은 서비스가 어떤
          개인정보를, 왜, 어떻게 수집·이용·보관하는지를 안내합니다.
        </p>
      </LegalSection>

      <LegalSection heading="2. 수집하는 개인정보 항목">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>소셜 로그인 시</strong>: 카카오·네이버·구글 계정으로 로그인하는 경우 해당
            제공자로부터 이름(닉네임), 이메일 주소, 프로필 이미지를 전달받습니다.
          </li>
          <li>
            <strong>리뷰·제보 작성 시</strong>: 이용자가 입력한 닉네임, 평가 내용, 작성 일시.
            비회원도 리뷰를 작성할 수 있으며 이 경우 별도 계정정보는 수집하지 않습니다.
          </li>
          <li>
            <strong>자동 수집</strong>: 서비스 이용 과정에서 접속 로그, 쿠키, 기기·브라우저 정보,
            방문 기록 등이 자동으로 생성·수집될 수 있습니다.
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="3. 개인정보의 이용 목적">
        <ul className="list-disc space-y-2 pl-5">
          <li>회원 식별 및 로그인 유지</li>
          <li>리뷰·제보 등 이용자 콘텐츠의 게시 및 관리</li>
          <li>서비스 운영·개선 및 이용 통계 분석</li>
          <li>부정 이용 방지 및 문의 응대</li>
        </ul>
      </LegalSection>

      <LegalSection heading="4. 개인정보의 보유 및 이용 기간">
        <p>
          이용자의 개인정보는 수집·이용 목적이 달성되면 지체 없이 파기합니다. 다만 회원 정보는 회원
          탈퇴 시까지, 이용자가 작성한 리뷰·제보는 삭제 요청 또는 게시 중단 시까지 보관하며, 관련
          법령에서 보존을 요구하는 경우 해당 기간 동안 보관합니다.
        </p>
      </LegalSection>

      <LegalSection heading="5. 개인정보의 제3자 제공 및 처리위탁">
        <p>
          서비스는 이용자의 개인정보를 외부에 판매하거나 제공하지 않습니다. 다만 서비스 운영을 위해
          아래와 같은 외부 서비스를 이용하며, 이 과정에서 관련 정보가 처리될 수 있습니다.
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>Google Analytics</strong>: 서비스 이용 통계 분석을 위해 쿠키 기반의 비식별 이용
            정보가 수집됩니다.
          </li>
          <li>
            <strong>소셜 로그인 제공자(카카오·네이버·구글)</strong>: 로그인 인증 처리.
          </li>
          <li>
            <strong>인프라 제공자(Cloudflare)</strong>: 서비스 호스팅 및 데이터 저장.
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="6. 쿠키의 사용">
        <p>
          서비스는 로그인 유지 및 이용 통계를 위해 쿠키를 사용합니다. 이용자는 브라우저 설정을 통해
          쿠키 저장을 거부할 수 있으나, 이 경우 로그인 등 일부 기능의 이용이 제한될 수 있습니다.
        </p>
      </LegalSection>

      <LegalSection heading="7. 이용자의 권리">
        <p>
          이용자는 언제든지 자신의 개인정보에 대한 열람·정정·삭제·처리정지를 요청할 수 있습니다.
          요청은 아래 연락처를 통해 접수하며, 서비스는 관련 법령에 따라 지체 없이 조치합니다.
        </p>
      </LegalSection>

      <LegalSection heading="8. 개인정보의 안전성 확보 조치">
        <p>
          서비스는 개인정보의 분실·도난·유출·변조를 방지하기 위해 접근 권한 관리, 전송 구간 암호화
          (HTTPS) 등 합리적인 보호 조치를 시행합니다.
        </p>
      </LegalSection>

      <LegalSection heading="9. 개인정보 보호책임자 및 문의">
        <p>개인정보 처리에 관한 문의, 불만 처리, 피해 구제 등은 아래로 연락해 주세요.</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>개인정보 보호책임자: {PRIVACY_OFFICER}</li>
          <li>
            연락처:{' '}
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="text-blue-600 underline underline-offset-2"
            >
              {CONTACT_EMAIL}
            </a>
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="10. 방침의 변경">
        <p>
          본 개인정보처리방침은 법령·서비스 변경에 따라 개정될 수 있으며, 변경 시 본 페이지를 통해
          공지합니다.
        </p>
      </LegalSection>
    </LegalShell>
  )
}
