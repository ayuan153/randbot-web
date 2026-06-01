"""
policy_value_net.py — Combined Policy + Value network for AlphaZero-style training.

Architecture:
  - Shared trunk (input → 256 → 256)
  - Policy head (256 → 128 → max_actions) — action probabilities
  - Value head (256 → 64 → 1) — win probability [-1, 1]

Input: 225-dim feature vector from net-features.ts extractFeatures()
Output: (policy: [batch, max_actions], value: [batch, 1])
"""

import torch
import torch.nn as nn
import torch.nn.functional as F


class PolicyValueNet(nn.Module):
    """Combined policy + value network for Pokémon battle evaluation."""

    def __init__(self, input_dim: int = 225, max_actions: int = 10):
        """
        Args:
            input_dim: Feature vector size (225 from extractFeatures)
            max_actions: Max legal actions (4 moves + 5 switches + 1 tera = 10)
        """
        super().__init__()

        # Shared trunk
        self.trunk = nn.Sequential(
            nn.Linear(input_dim, 256),
            nn.ReLU(),
            nn.Dropout(0.1),
            nn.Linear(256, 256),
            nn.ReLU(),
        )

        # Policy head: outputs logits over actions
        self.policy_head = nn.Sequential(
            nn.Linear(256, 128),
            nn.ReLU(),
            nn.Linear(128, max_actions),
        )

        # Value head: outputs scalar in [-1, 1]
        self.value_head = nn.Sequential(
            nn.Linear(256, 64),
            nn.ReLU(),
            nn.Linear(64, 1),
            nn.Tanh(),
        )

    def forward(
        self, x: torch.Tensor, action_mask: torch.Tensor | None = None
    ) -> tuple[torch.Tensor, torch.Tensor]:
        """
        Forward pass.

        Args:
            x: Feature tensor [batch, input_dim]
            action_mask: Boolean mask [batch, max_actions] — True for legal actions

        Returns:
            policy: Action probabilities [batch, max_actions]
            value: Win probability estimate [batch, 1]
        """
        trunk = self.trunk(x)

        # Policy
        policy_logits = self.policy_head(trunk)
        if action_mask is not None:
            # Mask illegal actions with large negative value
            policy_logits = policy_logits.masked_fill(~action_mask, -1e9)
        policy = F.softmax(policy_logits, dim=-1)

        # Value
        value = self.value_head(trunk)

        return policy, value


if __name__ == "__main__":
    # Quick sanity check
    model = PolicyValueNet()
    x = torch.randn(4, 225)
    mask = torch.ones(4, 10, dtype=torch.bool)
    mask[:, 7:] = False  # mask out last 3 actions

    policy, value = model(x, mask)
    print(f"Policy shape: {policy.shape}")  # [4, 10]
    print(f"Value shape: {value.shape}")    # [4, 1]
    print(f"Policy sums: {policy.sum(dim=-1)}")  # should be ~1.0
    print(f"Masked probs (should be ~0): {policy[:, 7:]}")
    print("OK")
