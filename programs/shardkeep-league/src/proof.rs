//! League claim v1 ordered sum-Merkle bytes, matching leagueClaimProof.ts.
//! Account identity, bitmap replay protection and claim admission remain in the
//! program handler. Tests below were preserved before implementation; no run by LC.

use anchor_lang::prelude::*;
use solana_keccak_hasher::hash;
use crate::LeagueError;

// Local v1 wire constants, explicitly specified by 7002e405, not game policy.
pub const MAX_PROOF_DEPTH: usize = 10;
const LEAF_DOMAIN: u8 = 0x06;
const NODE_DOMAIN: u8 = 0x07;

/// Exactly 41 Borsh bytes. Anchor's bool decoder rejects values other than 0/1.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProofNode {
    pub hash: [u8; 32],
    pub sum: u64,
    pub is_left: bool,
}

pub fn leaf_preimage(program_id: &Pubkey, config: &Pubkey, week_start: i64,
    index: u16, claimant: &Pubkey, amount: u64) -> [u8; 115] {
    let mut bytes = [0u8; 115]; bytes[0] = LEAF_DOMAIN;
    bytes[1..33].copy_from_slice(program_id.as_ref()); bytes[33..65].copy_from_slice(config.as_ref());
    bytes[65..73].copy_from_slice(&week_start.to_le_bytes()); bytes[73..75].copy_from_slice(&index.to_le_bytes());
    bytes[75..107].copy_from_slice(claimant.as_ref()); bytes[107..115].copy_from_slice(&amount.to_le_bytes()); bytes
}
pub fn leaf_hash(program_id: &Pubkey, config: &Pubkey, week_start: i64,
    index: u16, claimant: &Pubkey, amount: u64) -> [u8; 32] {
    hash(&leaf_preimage(program_id, config, week_start, index, claimant, amount)).0
}
pub fn node_preimage(left: &[u8; 32], left_sum: u64, right: &[u8; 32], right_sum: u64) -> Result<[u8; 81]> {
    left_sum.checked_add(right_sum).ok_or(LeagueError::ArithmeticOverflow)?;
    let mut bytes = [0u8; 81]; bytes[0] = NODE_DOMAIN;
    bytes[1..33].copy_from_slice(left); bytes[33..41].copy_from_slice(&left_sum.to_le_bytes());
    bytes[41..73].copy_from_slice(right); bytes[73..81].copy_from_slice(&right_sum.to_le_bytes()); Ok(bytes)
}
pub fn node_hash(left: &[u8; 32], left_sum: u64, right: &[u8; 32], right_sum: u64) -> Result<[u8; 32]> {
    Ok(hash(&node_preimage(left, left_sum, right, right_sum)?).0)
}

/// Ordered inclusion and authenticated sum only. A missing odd sibling is
/// promoted unchanged by the builder; it is never duplicated in this proof.
pub fn verify_proof(leaf_hash: [u8; 32], amount: u64, proof: &[ProofNode], root: [u8; 32], total: u64) -> Result<()> {
    require!(proof.len() <= MAX_PROOF_DEPTH, LeagueError::ProofTooDeep);
    let mut current = leaf_hash; let mut running = amount;
    for sibling in proof {
        let next = running.checked_add(sibling.sum).ok_or(LeagueError::ArithmeticOverflow)?;
        current = if sibling.is_left { node_hash(&sibling.hash, sibling.sum, &current, running)? }
            else { node_hash(&current, running, &sibling.hash, sibling.sum)? };
        running = next;
    }
    require!(current == root && running == total, LeagueError::InvalidProof); Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::LEAGUE_SKR_MAX_PLACES;
    use anchor_lang::prelude::*;
    use solana_keccak_hasher::hash;

    // Independent OpenSSL 3.6.1 KECCAK-256 pins; empty-input KAT passed before derivation.
    // Fixed wire vectors, not game policy; identical literals are in leagueClaimProof.test.ts.
    const P1_LEAF_HEX: &str = "b5020bedeca14d0cff2dcfd129fd2b7f062cafd90d6a54c0496aacb70cb8e589";
    const P2_NODE_HEX: &str = "27b371b23ef1b3eee41127a0478445cbec4e2560973c69232096f2857d91b283";
    const P3_EMPTY_HEX: &str = "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";
    const P4_TWO_ROOT_HEX: &str = "5412a7764d1065386cd8d4ff2abf612a2fc5ebf64f9521bae1f92ea45d2fcec1";
    const P4_THREE_ROOT_HEX: &str = "43281f6c0cca6cfa9e86f25220a36a2c28599ce683b80ca1812f8bf57a5c5099";
    const P5_ROOT_HEX: &str = "4f1ff6117728475172dda7d2c35f811a80b38fc56bbf375063e3c3d15be84b08";
    const P5_PROOF_0_HEX: &str = "09000000deb8e1c159156beda32f8fe99f868506abef52986ff341ff746ac6cc11b27c0c020000000000000000122ff1a10cfadc33c26827d9c391af81fe1b9ec03ccaf06adb1d097a28465115070000000000000000048e39850b6cf2d6f3eb2d965fe72648437ffce316811e4db75e609dadf91f5c1a000000000000000099bd0dbc08313068f440e079eff1c0d4dac32aef65f9ab3aa65c3f7d13f1d63b640000000000000000f574f5eaa6f88c659a0126866b257a6d5febd1e591692479c34fd977a97ea22d88010000000000000090edb142dbf637e4de8a361d343c995cf0e266de1b4541ddec09a7f6963d8f9c100600000000000000630a62d1dfe5a29b7795410ae0f8ae449ef0ed40383c98728ff07f4eddf5c8c0201800000000000000ba4a7ec9a8152c890a28742a45d48179cdf6279d337348ce68df186909f1f332406000000000000000382ba5c12406fb642ae35fa433a9bbe18592591fa0bf7b21b37c0c7f1e44aea8c26801000000000000";
    const P5_PROOF_499_HEX: &str = "07000000422f201ecc0e111ca98bb8daf0cdd2531534376b4d4c7a9197708b90b642d8bff301000000000000017958c3c3632f1014548954f8fdb132a3f05e11939f223adf357012bbfc1ef347e30300000000000001b79a70c57c34d9c8d1b2fcb220d20eefa5960dd3cc6c393a3b4c6c71c57b76d6881e000000000000013ec318eb214428764ac6ec8ab5e63bb4c59d615512e8f64b5ec3c76d530fccbf103a00000000000001bbe96ffd6cdd5ac128522247c05a4f77e9c2b843eb61c8fb339f0ea0044ab9252068000000000000016f5de58abebd3611a21ca21f1440e08e13d9c6d3a9435171d838382d58dfdae440a0000000000000014522ebe1d53f12e67a51196871500f2ef5f799c0910aefb4fe0e764b65486671808000000000000001";
    fn literal_bytes(value: &str) -> Vec<u8> {
        assert_eq!(value.len() % 2, 0);
        (0..value.len()).step_by(2).map(|i| u8::from_str_radix(&value[i..i + 2], 16).unwrap()).collect()
    }
    fn literal_hash(value: &str) -> [u8; 32] { literal_bytes(value).try_into().unwrap() }

    #[test]
    fn p3_independent_empty_input_keccak_known_answer() {
        assert_eq!(hex(&hash(&[]).0), P3_EMPTY_HEX);
    }

    fn program() -> Pubkey { Pubkey::new_from_array([0x11; 32]) }
    fn config() -> Pubkey { Pubkey::new_from_array([0x22; 32]) }
    fn claimant() -> Pubkey { Pubkey::new_from_array([0x33; 32]) }
    fn leaf(index: u16) -> [u8; 32] {
        leaf_hash(&program(), &config(), 345600, index, &claimant(), u64::from(index) + 1)
    }
    fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }
    fn code(result: Result<()>, expected: &str) {
        match result.expect_err("negative proof case must fail") {
            anchor_lang::error::Error::AnchorError(error) => assert_eq!(error.error_name, expected),
            error => panic!("expected Anchor error {expected}, got {error:?}"),
        }
    }
    fn reference_node(left: &[u8; 32], left_sum: u64, right: &[u8; 32], right_sum: u64) -> [u8; 32] {
        let mut bytes = vec![0x07]; bytes.extend_from_slice(left); bytes.extend_from_slice(&left_sum.to_le_bytes());
        bytes.extend_from_slice(right); bytes.extend_from_slice(&right_sum.to_le_bytes()); hash(&bytes).0
    }
    fn pair() -> ([u8; 32], ProofNode) {
        (reference_node(&leaf(0), 1, &leaf(1), 2), ProofNode { hash: leaf(1), sum: 2, is_left: false })
    }
    fn tree_levels(leaf_count: u16) -> Vec<Vec<([u8; 32], u64)>> {
        let mut levels: Vec<Vec<([u8; 32], u64)>> = vec![(0..leaf_count).map(|i| (leaf(i), u64::from(i) + 1)).collect()];
        while levels.last().unwrap().len() > 1 {
            let next = levels.last().unwrap().chunks(2).map(|pair| {
                if pair.len() == 1 { pair[0] }
                else { (reference_node(&pair[0].0, pair[0].1, &pair[1].0, pair[1].1), pair[0].1 + pair[1].1) }
            }).collect(); levels.push(next);
        }
        levels
    }
    fn tree_proof(levels: &[Vec<([u8; 32], u64)>], index: u16) -> Vec<ProofNode> {
        let mut position = usize::from(index); let mut proof = Vec::new();
        for level in &levels[..levels.len() - 1] {
            if let Some(sibling) = level.get(position ^ 1) {
                proof.push(ProofNode { hash: sibling.0, sum: sibling.1, is_left: position % 2 == 1 });
            }
            position /= 2;
        }
        proof
    }

    #[test]
    fn case_01_exact_cross_language_leaf_and_node_preimages() {
        let bytes = leaf_preimage(&program(), &config(), 345600, 257, &claimant(), 0x0102030405060708);
        let expected = format!("06{}{}00460500000000000101{}0807060504030201", "11".repeat(32), "22".repeat(32), "33".repeat(32));
        assert_eq!(hex(&bytes), expected); assert_eq!(bytes.len(), 115);
        assert_eq!(hex(&leaf_hash(&program(), &config(), 345600, 257, &claimant(), 0x0102030405060708)), P1_LEAF_HEX);
        assert_eq!(leaf_hash(&program(), &config(), 345600, 257, &claimant(), 0x0102030405060708), hash(&bytes).0);
        let expected_node = format!("07{}0100000000000000{}0200000000000000", "44".repeat(32), "55".repeat(32));
        let bytes = node_preimage(&[0x44; 32], 1, &[0x55; 32], 2).unwrap();
        assert_eq!(hex(&bytes), expected_node); assert_eq!(bytes.len(), 81);
        assert_eq!(hex(&node_hash(&[0x44; 32], 1, &[0x55; 32], 2).unwrap()), P2_NODE_HEX);
        assert_eq!(node_hash(&[0x44; 32], 1, &[0x55; 32], 2).unwrap(), reference_node(&[0x44; 32], 1, &[0x55; 32], 2));
    }

    #[test]
    fn case_02_all_six_leaf_fields_are_bound_invalid_proof() {
        let (root, sibling) = pair(); let other = Pubkey::new_from_array([0x77; 32]);
        for changed in [leaf_hash(&other, &config(), 345600, 0, &claimant(), 1),
            leaf_hash(&program(), &other, 345600, 0, &claimant(), 1),
            leaf_hash(&program(), &config(), 345601, 0, &claimant(), 1),
            leaf_hash(&program(), &config(), 345600, 2, &claimant(), 1),
            leaf_hash(&program(), &config(), 345600, 0, &other, 1)] {
            code(verify_proof(changed, 1, &[sibling.clone()], root, 3), "InvalidProof");
        }
        code(verify_proof(leaf_hash(&program(), &config(), 345600, 0, &claimant(), 2), 2, &[sibling], root, 3), "InvalidProof");
    }

    #[test]
    fn case_03_sibling_hash_sum_side_root_and_total_are_bound_invalid_proof() {
        let (root, sibling) = pair();
        for changed in [ProofNode { hash: [0; 32], ..sibling.clone() }, ProofNode { sum: 3, ..sibling.clone() },
            ProofNode { is_left: true, ..sibling.clone() }] {
            code(verify_proof(leaf(0), 1, &[changed], root, 3), "InvalidProof");
        }
        code(verify_proof(leaf(0), 1, &[], root, 3), "InvalidProof");
        code(verify_proof(leaf(0), 1, &[sibling.clone()], [0; 32], 3), "InvalidProof");
        code(verify_proof(leaf(0), 1, &[sibling], root, 4), "InvalidProof");
    }

    #[test]
    fn case_04_node_as_leaf_and_foreign_domains_are_invalid_proof() {
        for prefix in [0x00, 0x02] {
            let mut bytes = leaf_preimage(&program(), &config(), 345600, 0, &claimant(), 1); bytes[0] = prefix;
            code(verify_proof(leaf(0), 1, &[], hash(&bytes).0, 1), "InvalidProof");
        }
        let (root, sibling) = pair(); code(verify_proof(leaf(0), 1, &[], root, 1), "InvalidProof");
        for prefix in [0x01, 0x04] {
            let mut bytes = node_preimage(&leaf(0), 1, &leaf(1), 2).unwrap(); bytes[0] = prefix;
            code(verify_proof(leaf(0), 1, &[sibling.clone()], hash(&bytes).0, 3), "InvalidProof");
        }
    }

    #[test]
    fn case_05_depth_ten_passes_depth_eleven_is_proof_too_deep() {
        let mut proof = Vec::new(); let mut root = leaf(0); let mut total = 1;
        for depth in 1..=11 {
            let sibling = ProofNode { hash: [depth; 32], sum: 1, is_left: depth % 2 == 0 };
            root = if sibling.is_left { reference_node(&sibling.hash, 1, &root, total) }
                else { reference_node(&root, total, &sibling.hash, 1) };
            total += 1; proof.push(sibling);
            if depth <= 10 { verify_proof(leaf(0), 1, &proof, root, total).unwrap(); }
            else { code(verify_proof(leaf(0), 1, &proof, root, total), "ProofTooDeep"); }
        }
        assert_eq!(MAX_PROOF_DEPTH, 10);
    }

    #[test]
    fn case_06_all_sum_overflow_is_arithmetic_overflow() {
        code(node_hash(&[1; 32], u64::MAX, &[2; 32], 1).map(|_| ()), "ArithmeticOverflow");
        for is_left in [true, false] {
            code(verify_proof(leaf(0), u64::MAX, &[ProofNode { hash: [2; 32], sum: 1, is_left }], [0; 32], 0), "ArithmeticOverflow");
        }
        let proof = [ProofNode { hash: [1; 32], sum: u64::MAX - 1, is_left: false },
            ProofNode { hash: [2; 32], sum: 1, is_left: true }];
        code(verify_proof(leaf(0), 1, &proof, [0; 32], 0), "ArithmeticOverflow");
    }

    #[test]
    fn case_07_singleton_and_odd_node_promotion_do_not_invent_siblings() {
        let last_index = LEAGUE_SKR_MAX_PLACES - 1; let amount = u64::from(LEAGUE_SKR_MAX_PLACES);
        verify_proof(leaf(last_index), amount, &[], leaf(last_index), amount).unwrap();
        let (pair_root, sibling) = pair(); let root = reference_node(&pair_root, 3, &leaf(2), 3);
        assert_eq!(hex(&pair_root), P4_TWO_ROOT_HEX); assert_eq!(hex(&root), P4_THREE_ROOT_HEX);
        verify_proof(leaf(0), 1, &[sibling], literal_hash(P4_TWO_ROOT_HEX), 3).unwrap();
        verify_proof(leaf(2), 3, &[ProofNode { hash: literal_hash(P4_TWO_ROOT_HEX), sum: 3, is_left: true }],
            literal_hash(P4_THREE_ROOT_HEX), 6).unwrap();
        verify_proof(leaf(2), 3, &[ProofNode { hash: pair_root, sum: 3, is_left: true }], root, 6).unwrap();
        verify_proof(leaf(0), 1, &[sibling, ProofNode { hash: leaf(2), sum: 3, is_left: false }], root, 6).unwrap();
    }

    #[test]
    fn case_39_min1_policy_maximum_tree_sum_and_each_proof_are_conserved() {
        let levels = tree_levels(LEAGUE_SKR_MAX_PLACES);
        let (root, total) = levels.last().unwrap()[0]; let count = u64::from(LEAGUE_SKR_MAX_PLACES);
        assert_eq!(total, count * (count + 1) / 2);
        assert_eq!(levels[0].len(), usize::from(LEAGUE_SKR_MAX_PLACES));
        let tree_depth = levels.len() - 1; assert!(tree_depth <= MAX_PROOF_DEPTH);
        for index in 0..LEAGUE_SKR_MAX_PLACES {
            let proof = tree_proof(&levels, index);
            assert!(proof.len() <= tree_depth); verify_proof(leaf(index), u64::from(index) + 1, &proof, root, total).unwrap();
        }
    }

    #[test]
    fn case_08_p5_fixed_five_hundred_leaf_fixture_is_separate_from_policy() {
        // This fixed wire fixture is deliberately independent of changing game policy.
        let levels = tree_levels(500); let (root, total) = levels.last().unwrap()[0];
        assert_eq!(levels[0].len(), 500); assert_eq!(total, 125250);
        assert_eq!(hex(&root), P5_ROOT_HEX);
        for (index, depth) in [(0u16, 9usize), (499, 7)] {
            let proof = tree_proof(&levels, index); assert_eq!(proof.len(), depth);
            let expected = if index == 0 { P5_PROOF_0_HEX } else { P5_PROOF_499_HEX };
            assert_eq!(hex(&proof.try_to_vec().unwrap()), expected);
            let pinned_proof = Vec::<ProofNode>::try_from_slice(&literal_bytes(expected)).unwrap();
            assert_eq!(proof, pinned_proof);
            verify_proof(leaf(index), u64::from(index) + 1, &pinned_proof, literal_hash(P5_ROOT_HEX), 125250).unwrap();
            verify_proof(leaf(index), u64::from(index) + 1, &proof, root, total).unwrap();
        }
        // Literal roots and complete Borsh proofs bind the independently hashed fixed vector.
    }

    #[test]
    fn proof_node_has_exact_borsh_bytes_and_strict_boolean() {
        let node = ProofNode { hash: [0x44; 32], sum: 1, is_left: true };
        let expected = format!("{}010000000000000001", "44".repeat(32));
        let bytes = node.try_to_vec().unwrap(); assert_eq!(bytes.len(), 41); assert_eq!(hex(&bytes), expected);
        assert_eq!(ProofNode::try_from_slice(&bytes).unwrap(), node);
        let mut invalid = bytes.clone(); invalid[40] = 2; assert!(ProofNode::try_from_slice(&invalid).is_err());
        let mut trailing = bytes.clone(); trailing.push(0); assert!(ProofNode::try_from_slice(&trailing).is_err());
        assert!(ProofNode::try_from_slice(&bytes[..40]).is_err());
    }
}
