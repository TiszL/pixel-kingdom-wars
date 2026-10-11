//! Cumulative mining proof bytes, matching B3a miningAllocationProof.ts.
//! Membership binds KEEP, Renown, days and sequence; it grants no claim authority.

use anchor_lang::prelude::*;
use solana_keccak_hasher::hash;

// E1 §4.3 / B3a wire and hashing work bound; not an economy parameter.
pub const MAX_PROOF_DEPTH: usize = 16;

/// Exactly 41 Borsh bytes. Anchor's bool decoder rejects any side other than 0/1.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProofNode {
    pub hash: [u8; 32],
    pub sum: u64,
    pub is_left: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AllocationLeaf {
    pub wallet: Pubkey,
    pub cumulative_keep: u64,
    pub cumulative_renown: u64,
    pub cumulative_days: u64,
    pub sequence: u64,
}

fn leaf_preimage(leaf: &AllocationLeaf) -> [u8; 65] {
    let mut bytes = [0; 65];
    bytes[0] = 0x02;
    bytes[1..33].copy_from_slice(leaf.wallet.as_ref());
    bytes[33..41].copy_from_slice(&leaf.cumulative_keep.to_le_bytes());
    bytes[41..49].copy_from_slice(&leaf.cumulative_renown.to_le_bytes());
    bytes[49..57].copy_from_slice(&leaf.cumulative_days.to_le_bytes());
    bytes[57..65].copy_from_slice(&leaf.sequence.to_le_bytes());
    bytes
}

pub fn hash_leaf(leaf: &AllocationLeaf) -> [u8; 32] {
    hash(&leaf_preimage(leaf)).0
}

fn node_preimage(left: &[u8; 32], left_sum: u64, right: &[u8; 32], right_sum: u64) -> Option<[u8; 81]> {
    left_sum.checked_add(right_sum)?;
    let mut bytes = [0; 81];
    bytes[0] = 0x04;
    bytes[1..33].copy_from_slice(left);
    bytes[33..41].copy_from_slice(&left_sum.to_le_bytes());
    bytes[41..73].copy_from_slice(right);
    bytes[73..81].copy_from_slice(&right_sum.to_le_bytes());
    Some(bytes)
}

pub fn hash_node(left: &[u8; 32], left_sum: u64, right: &[u8; 32], right_sum: u64) -> Option<[u8; 32]> {
    Some(hash(&node_preimage(left, left_sum, right, right_sum)?).0)
}

/// Verify ordered hash AND KEEP sum. Wallet ordering/unique leaves, economic
/// limits, account identity, root status and sequence authorization belong to
/// publication/claim handlers. Odd tree nodes promote unchanged in B3a, so no
/// leaf index or fabricated missing sibling is required here.
pub fn verify(leaf: &AllocationLeaf, proof: &[ProofNode], root: &[u8; 32], total: u64) -> bool {
    if proof.len() > MAX_PROOF_DEPTH {
        return false;
    }
    let mut current = hash_leaf(leaf);
    let mut running = leaf.cumulative_keep;
    for sibling in proof {
        let Some(next) = running.checked_add(sibling.sum) else { return false; };
        let node = if sibling.is_left {
            hash_node(&sibling.hash, sibling.sum, &current, running)
        } else {
            hash_node(&current, running, &sibling.hash, sibling.sum)
        };
        let Some(node) = node else { return false; };
        current = node;
        running = next;
    }
    running == total && current == *root
}

#[cfg(test)]
mod tests {
    use super::*;

    // Exact B3a/S3 vectors, not generated expectations from this implementation.
    const LEAF_0: &str = "0200000000000000000000000000000000000000000000000000000000000000aae803000000000000000000000000000000000000000000000100000000000000";
    const HASH_0: &str = "e105f3ff6de90b90c56e701926ac9729e1933aadb1bdce36da3421fc0109fce7";
    const HASH_1: &str = "d1f3a0f044ae6a49d499bdddc528551416648d61e0a9980c9129155f3d142866";
    const NODE_01: &str = "285cb8f554227b39c3ab1e14bc1fcf39dbfbbab291f0599e2c0ef779cb53e113";

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
    fn bytes<const N: usize>(value: &str) -> [u8; N] {
        assert_eq!(value.len(), N * 2);
        let mut out = [0; N];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }
    fn leaf(i: u64) -> AllocationLeaf {
        let mut wallet = [0; 32];
        wallet[..8].copy_from_slice(&i.to_le_bytes());
        wallet[31] = 0xaa;
        AllocationLeaf { wallet: Pubkey::new_from_array(wallet), cumulative_keep: 1000 + i * 7,
            cumulative_renown: i % 13, cumulative_days: i % 30, sequence: i + 1 }
    }
    fn right() -> ProofNode {
        ProofNode { hash: bytes(HASH_1), sum: 1007, is_left: false }
    }

    #[test]
    fn exact_cross_language_leaf_and_ordered_node_preimages() {
        assert_eq!(hex(&leaf_preimage(&leaf(0))), LEAF_0);
        assert_eq!(hex(&hash_leaf(&leaf(0))), HASH_0);
        assert_eq!(hex(&hash_leaf(&leaf(1))), HASH_1);
        let expected = format!("04{HASH_0}e803000000000000{HASH_1}ef03000000000000");
        assert_eq!(hex(&node_preimage(&bytes(HASH_0), 1000, &bytes(HASH_1), 1007).unwrap()), expected);
        assert_eq!(hex(&hash_node(&bytes(HASH_0), 1000, &bytes(HASH_1), 1007).unwrap()), NODE_01);
        assert_ne!(hash_node(&bytes(HASH_1), 1007, &bytes(HASH_0), 1000), Some(bytes(NODE_01)));
        assert!(verify(&leaf(0), &[right()], &bytes(NODE_01), 2007));
        assert!(verify(&leaf(1), &[ProofNode { hash: bytes(HASH_0), sum: 1000, is_left: true }], &bytes(NODE_01), 2007));
    }

    #[test]
    fn canonical_borsh_side_and_exact_41_byte_nodes() {
        let left = ProofNode { hash: bytes(HASH_0), sum: 1000, is_left: true };
        assert_eq!(hex(&left.try_to_vec().unwrap()), format!("{HASH_0}e80300000000000001"));
        assert_eq!(hex(&right().try_to_vec().unwrap()), format!("{HASH_1}ef0300000000000000"));
        let proof = vec![left, right()];
        let encoded = proof.try_to_vec().unwrap();
        assert_eq!(hex(&encoded), format!("02000000{HASH_0}e80300000000000001{HASH_1}ef0300000000000000"));
        assert_eq!(Vec::<ProofNode>::try_from_slice(&encoded).unwrap(), proof);
        assert_eq!(Vec::<ProofNode>::new().try_to_vec().unwrap(), [0; 4]);
        for invalid in [2, 255] {
            let mut malformed = left.try_to_vec().unwrap();
            malformed[40] = invalid;
            assert!(ProofNode::try_from_slice(&malformed).is_err());
        }
        let mut trailing = left.try_to_vec().unwrap();
        trailing.push(0);
        assert!(ProofNode::try_from_slice(&trailing).is_err());
        assert!(ProofNode::try_from_slice(&trailing[..40]).is_err());
        assert!(Vec::<ProofNode>::try_from_slice(&encoded[..encoded.len() - 1]).is_err());
        let mut trailing = encoded;
        trailing.push(0);
        assert!(Vec::<ProofNode>::try_from_slice(&trailing).is_err());
    }

    #[test]
    fn every_leaf_field_is_bound_without_imposing_economic_policy() {
        let original = leaf(0);
        let mut changed = [original; 5];
        changed[0].wallet = leaf(2).wallet;
        changed[1].cumulative_keep += 1;
        changed[2].cumulative_renown += 1;
        changed[3].cumulative_days += 1;
        changed[4].sequence += 1;
        for item in changed {
            assert!(!verify(&item, &[right()], &bytes(NODE_01), 2007));
        }
        // The claim handler, not the codec, must enforce Renown/day bounds.
        let policy_invalid = AllocationLeaf { cumulative_renown: 99, cumulative_days: 0, ..original };
        assert!(verify(&policy_invalid, &[], &hash_leaf(&policy_invalid), policy_invalid.cumulative_keep));
    }

    #[test]
    fn sibling_hash_sum_side_and_root_total_are_independently_bound() {
        for sibling in [ProofNode { hash: [0; 32], ..right() },
            ProofNode { sum: 1008, ..right() }, ProofNode { is_left: true, ..right() }] {
            assert!(!verify(&leaf(0), &[sibling], &bytes(NODE_01), 2007));
        }
        assert!(!verify(&leaf(0), &[], &bytes(NODE_01), 2007));
        assert!(!verify(&leaf(0), &[right()], &[0; 32], 2007));
        assert!(!verify(&leaf(0), &[right()], &bytes(NODE_01), 2008));
        // A matching hash cannot substitute for the authenticated sum.
        assert!(!verify(&leaf(0), &[right()], &bytes(NODE_01), 2006));
    }

    #[test]
    fn domains_prevent_distributor_por_or_node_as_leaf_reinterpretation() {
        let mut wrong_domain = leaf_preimage(&leaf(0));
        wrong_domain[0] = 0x00;
        assert!(!verify(&leaf(0), &[], &hash(&wrong_domain).0, 1000));
        let mut wrong_node = node_preimage(&bytes(HASH_0), 1000, &bytes(HASH_1), 1007).unwrap();
        wrong_node[0] = 0x01;
        assert!(!verify(&leaf(0), &[right()], &hash(&wrong_node).0, 2007));
        assert!(!verify(&leaf(0), &[], &bytes(NODE_01), 1000));
    }

    #[test]
    fn singleton_zero_keep_and_odd_promoted_node_need_no_phantom_sibling() {
        let zero = AllocationLeaf { cumulative_keep: 0, ..leaf(0) };
        assert!(verify(&zero, &[], &hash_leaf(&zero), 0));
        let third = leaf(2);
        let root = hash_node(&bytes(NODE_01), 2007, &hash_leaf(&third), 1014).unwrap();
        assert!(verify(&third, &[ProofNode { hash: bytes(NODE_01), sum: 2007, is_left: true }], &root, 3021));
        assert!(verify(&leaf(0), &[right(), ProofNode { hash: hash_leaf(&third), sum: 1014, is_left: false }], &root, 3021));
    }

    #[test]
    fn checked_sum_overflow_refuses_instead_of_wrapping() {
        let max = AllocationLeaf { cumulative_keep: u64::MAX, ..leaf(0) };
        assert!(verify(&max, &[], &hash_leaf(&max), u64::MAX));
        assert!(hash_node(&hash_leaf(&max), u64::MAX, &bytes(HASH_1), 1).is_none());
        assert!(hash_node(&bytes(HASH_1), 1, &hash_leaf(&max), u64::MAX).is_none());
        for is_left in [true, false] {
            assert!(!verify(&max, &[ProofNode { hash: bytes(HASH_1), sum: 1, is_left }], &[0; 32], 0));
        }
        let proof = [ProofNode { hash: [1; 32], sum: u64::MAX - 1000, is_left: false },
            ProofNode { hash: [2; 32], sum: 1, is_left: false }];
        assert!(!verify(&leaf(0), &proof, &[0; 32], 0));
    }

    #[test]
    fn depth_16_is_valid_but_17_is_refused_even_with_a_matching_root() {
        assert_eq!(MAX_PROOF_DEPTH, 16);
        let item = leaf(0);
        let mut proof = Vec::new();
        let mut root = hash_leaf(&item);
        let mut total = item.cumulative_keep;
        for depth in 1..=17 {
            let sibling = ProofNode { hash: [depth as u8; 32], sum: 1, is_left: depth % 2 == 0 };
            root = if sibling.is_left { hash_node(&sibling.hash, sibling.sum, &root, total) }
                else { hash_node(&root, total, &sibling.hash, sibling.sum) }.unwrap();
            total += 1;
            proof.push(sibling);
            assert_eq!(verify(&item, &proof, &root, total), depth <= MAX_PROOF_DEPTH);
        }
    }

    #[test]
    fn published_s3_depth_14_root_matches_the_accepted_typescript_fixture() {
        // S3's original index order, also pinned by B3a; not a tree-construction API.
        let mut level: Vec<_> = (0..16384).map(|i| {
            let item = leaf(i); (hash_leaf(&item), item.cumulative_keep)
        }).collect();
        while level.len() > 1 {
            level = level.chunks_exact(2).map(|pair| {
                (hash_node(&pair[0].0, pair[0].1, &pair[1].0, pair[1].1).unwrap(),
                    pair[0].1.checked_add(pair[1].1).unwrap())
            }).collect();
        }
        assert_eq!(hex(&level[0].0), "bc0a648767fd2249868b97a0863ad3060fa7794ff6f844467724378071f82b1c");
        assert_eq!(level[0].1, 955850752);
    }
}
