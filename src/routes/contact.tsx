import { createFileRoute } from '@tanstack/react-router'
import { LegalSection, LegalShell } from '@/components/legal/LegalShell'
import { CONTACT_EMAIL } from '@/lib/site'

export const Route = createFileRoute('/contact')({
  head: () => ({
    meta: [
      { title: '문의하기 | 쉬운주차장' },
      {
        name: 'description',
        content:
          '쉬운주차장 서비스 문의, 주차장 정보 정정·제보, 제휴 문의를 받습니다. 이메일로 연락 주세요.',
      },
      {
        name: 'robots',
        content: 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1',
      },
      { property: 'og:title', content: '문의하기 | 쉬운주차장' },
      {
        property: 'og:description',
        content: '서비스 문의, 정보 정정·제보, 제휴 문의를 이메일로 받습니다.',
      },
      { property: 'og:type', content: 'website' },
      { property: 'og:url', content: 'https://easy-parking.xyz/contact' },
    ],
    links: [{ rel: 'canonical', href: 'https://easy-parking.xyz/contact' }],
  }),
  component: ContactPage,
})

function ContactPage() {
  return (
    <LegalShell title="문의하기">
      <LegalSection heading="이메일 문의">
        <p>
          서비스 이용, 주차장 정보 정정·제보, 제휴 등 모든 문의는 아래 이메일로 보내 주세요. 확인 후
          순차적으로 답변드립니다.
        </p>
        <p className="text-base font-semibold text-foreground">
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            className="text-blue-600 underline underline-offset-2"
          >
            {CONTACT_EMAIL}
          </a>
        </p>
      </LegalSection>

      <LegalSection heading="주차장 정보 정정·제보">
        <p>
          요금·운영시간·진입 난이도 등 잘못된 정보를 발견하셨다면, 해당 주차장 이름과 정정할 내용을
          함께 보내 주시면 빠르게 반영하겠습니다. 새 주차장 제보도 환영합니다.
        </p>
      </LegalSection>
    </LegalShell>
  )
}
