"""Export trained PyTorch ValueNet to ONNX format for browser inference."""

import os

import numpy as np
import onnx
import onnxruntime as ort
import torch


def export_to_onnx(model_path: str, output_path: str, input_dim: int = 245):
    """Export DualNet to ONNX (two outputs) and validate against PyTorch.

    Args:
        model_path: Path to saved .pt DualNet state dict.
        output_path: Where to write the .onnx file.
        input_dim: Input feature dimension (default 245).
    """
    from train.train_model import DualNet

    model = DualNet(input_dim=input_dim)
    model.load_state_dict(torch.load(model_path, map_location="cpu", weights_only=True))
    model.eval()

    dummy_input = torch.randn(1, input_dim)
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    torch.onnx.export(
        model,
        dummy_input,
        output_path,
        input_names=["state"],
        output_names=["win_probability", "policy_logits"],
        dynamic_axes={"state": {0: "batch_size"},
                      "win_probability": {0: "batch_size"},
                      "policy_logits": {0: "batch_size"}},
        opset_version=17,
    )

    onnx_model = onnx.load(output_path)
    onnx.checker.check_model(onnx_model)

    # Test inference matches PyTorch (both heads)
    sess = ort.InferenceSession(output_path)
    test_input = np.random.randn(1, input_dim).astype(np.float32)
    onnx_val, onnx_pol = sess.run(None, {"state": test_input})

    with torch.no_grad():
        torch_val, torch_pol = model(torch.FloatTensor(test_input))

    assert np.allclose(onnx_val, torch_val.numpy(), atol=1e-5), "value output mismatch!"
    assert np.allclose(onnx_pol, torch_pol.numpy(), atol=1e-5), "policy output mismatch!"
    print(f"Exported to {output_path} ({os.path.getsize(output_path) / 1024:.1f} KB)")
    print(f"Validation passed. value+policy match PyTorch within 1e-5. policy_dim={onnx_pol.shape[-1]}")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Export ValueNet to ONNX")
    parser.add_argument("--model", default="models/value-net-v1.pt")
    parser.add_argument("--output", default="models/value-net-v1.onnx")
    args = parser.parse_args()
    export_to_onnx(args.model, args.output)
