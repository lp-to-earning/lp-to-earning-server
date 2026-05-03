# [Frontend Task] 수수료 및 카피 보너스 수확 (Claim) 기능 연동

## 🎯 목표
사용자가 쌓인 포지션 수수료(Fee)와 카피 보너스(Bonus)를 수동으로 수령(Harvest)할 수 있도록 프론트엔드 UI를 구성하고 API를 연동합니다.

## 🔗 연동할 API 명세
백엔드에 수동 수확을 위한 API 엔드포인트가 준비되었습니다.

- **Endpoint**: `POST /api/positions/claim`
- **Headers**: 
  - `Authorization: Bearer <JWT_TOKEN>`
- **Request Body**:
  ```json
  {
    "nftMints": ["<NFT_MINT_ADDRESS_1>", "<NFT_MINT_ADDRESS_2>"]
  }
  ```
  *(수확할 대상 포지션들의 `nftMintAddress` 배열을 보냅니다)*

- **Response (Success)**:
  ```json
  {
    "success": true,
    "message": "Claim successful.",
    "data": { ... } 
  }
  ```

## 🛠️ UI/UX 작업 가이드 (추천 사항)
1. **UI 컴포넌트 위치**: 
   - `src/components/WithdrawSection.tsx` 또는 `MyPositions` 목록 화면의 상단에 **[수익 일괄 수확 (Claim All)]** 버튼을 추가하는 것을 추천합니다.
   
2. **활성화 조건 로직**: 
   - 기존의 `GET /api/positions` 로 불러온 데이터 중, `earnedUsd` 와 `bonusUsd` 를 합친 금액이 0보다 큰(의미 있는 수익이 있는) 포지션들의 `nftMintAddress`만 필터링합니다.
   - 필터링된 배열이 비어있다면 버튼을 `disabled` 처리해 주세요.

3. **로딩 처리 및 피드백**: 
   - 솔라나 온체인 트랜잭션이 발생하므로 응답까지 **수 초 이상** 걸릴 수 있습니다.
   - 버튼 클릭 시 로딩 스피너를 반드시 노출하고, 작업이 끝나면 Toast 메시지(성공/실패)를 띄운 뒤 포지션 목록을 `refetch` 해주세요.
