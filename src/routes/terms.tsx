import { createFileRoute } from '@tanstack/react-router'
import { LegalSection, LegalShell } from '@/components/legal/LegalShell'
import { CONTACT_EMAIL, LEGAL_EFFECTIVE_DATE, SITE_NAME } from '@/lib/site'

export const Route = createFileRoute('/terms')({
  head: () => ({
    meta: [{ title: '이용약관 | 쉬운주차장' }, { name: 'robots', content: 'noindex, follow' }],
    links: [{ rel: 'canonical', href: 'https://easy-parking.xyz/terms' }],
  }),
  component: TermsPage,
})

function TermsPage() {
  return (
    <LegalShell title="이용약관" updatedAt={LEGAL_EFFECTIVE_DATE}>
      <LegalSection heading="제1조 (목적)">
        <p>
          본 약관은 {SITE_NAME}(이하 “서비스”)가 제공하는 주차장 정보 제공 서비스의 이용과 관련하여
          서비스와 이용자 간의 권리·의무 및 책임사항을 규정함을 목적으로 합니다.
        </p>
      </LegalSection>

      <LegalSection heading="제2조 (서비스의 내용)">
        <p>
          서비스는 전국 주차장의 위치, 요금, 운영시간, 주차 난이도, 후기 등 정보를 수집·정리하여
          제공합니다. 제공되는 정보는 공공데이터, 공개된 웹 콘텐츠, 이용자 제보 등을 바탕으로 하며
          실제와 다를 수 있습니다.
        </p>
      </LegalSection>

      <LegalSection heading="제3조 (정보의 정확성)">
        <p>
          서비스는 정보의 정확성을 위해 노력하나, 요금·운영시간 등은 운영 주체의 사정에 따라 수시로
          변경될 수 있습니다. 이용자는 방문 전 현장 안내 또는 운영 주체를 통해 정보를 재확인해야
          하며, 서비스는 정보의 오류로 인해 발생한 손해에 대해 책임을 지지 않습니다.
        </p>
      </LegalSection>

      <LegalSection heading="제4조 (이용자의 의무)">
        <ul className="list-disc space-y-2 pl-5">
          <li>이용자는 타인의 권리를 침해하거나 법령을 위반하는 행위를 해서는 안 됩니다.</li>
          <li>
            리뷰·제보 등 이용자가 게시한 콘텐츠는 사실에 기반해야 하며, 허위·비방·광고성 내용을
            포함해서는 안 됩니다.
          </li>
          <li>
            서비스의 정상적인 운영을 방해하는 행위(과도한 자동화 수집, 시스템 공격 등)를 해서는 안
            됩니다.
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="제5조 (게시물의 관리)">
        <p>
          이용자가 작성한 리뷰·제보 등의 게시물이 본 약관 또는 관련 법령에 위반된다고 판단되는 경우,
          서비스는 사전 통지 없이 해당 게시물을 삭제하거나 노출을 제한할 수 있습니다.
        </p>
      </LegalSection>

      <LegalSection heading="제6조 (책임의 제한)">
        <p>
          서비스는 무료로 제공되는 정보 서비스로서, 천재지변·시스템 장애·제3자 데이터의 오류 등
          서비스가 통제할 수 없는 사유로 인한 손해에 대해 책임을 지지 않습니다.
        </p>
      </LegalSection>

      <LegalSection heading="제7조 (약관의 변경)">
        <p>
          서비스는 필요한 경우 관련 법령을 위배하지 않는 범위에서 본 약관을 개정할 수 있으며, 변경
          시 본 페이지를 통해 공지합니다. 변경된 약관은 공지한 시점부터 효력이 발생합니다.
        </p>
      </LegalSection>

      <LegalSection heading="문의">
        <p>
          본 약관에 관한 문의는{' '}
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            className="text-blue-600 underline underline-offset-2"
          >
            {CONTACT_EMAIL}
          </a>
          로 보내 주세요.
        </p>
      </LegalSection>
    </LegalShell>
  )
}
